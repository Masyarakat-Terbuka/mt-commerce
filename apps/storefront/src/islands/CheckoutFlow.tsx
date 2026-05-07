/**
 * CheckoutFlow — single React island that owns the multi-step checkout UI.
 *
 * Step model maps directly onto the API state machine:
 *
 *   pending           → Step 1 "Alamat"     (PUT /addresses)
 *   awaiting_shipping → Step 2 "Pengiriman" (PUT /shipping)
 *   awaiting_payment  → Step 3 "Pembayaran" (UI-only, single option)
 *   awaiting_payment  → Step 4 "Tinjauan"   (POST /complete + Idempotency-Key)
 *   completed         → navigate to /checkout/<orderIntentId>/confirmed
 *
 * The Step-3/Step-4 split lets the operator confirm a quiet "review" surface
 * before the irrevocable POST. The state machine itself does not change in
 * Step 3 — `paymentMethod` only crosses the wire on `complete`.
 *
 * Idempotency strategy — the headline guarantee:
 *
 *   - On first arrival at Step 4, the island generates a UUID via
 *     `crypto.randomUUID()` and stores it in component state.
 *   - The same key rides on every retry of the Confirm button. Even if the
 *     user double-clicks, the API's idempotency middleware short-circuits the
 *     second hit and returns the original response.
 *   - The key is cleared *only* when the user navigates away from the review
 *     step (e.g. clicks "Ubah" on a previous step) — at that point the
 *     request body would change anyway, so a fresh key is correct.
 *   - On a 409 `idempotency_key_reuse` we surface a calm error and reset
 *     the key. This branch only fires if the underlying body changed mid-
 *     flight; in practice it is a backstop, not a regular path.
 *
 * Cart handoff:
 *
 *   - The island reads the cart through `useCart()`. On gate it checks the
 *     cart is non-empty, otherwise renders the "empty cart" notice.
 *   - On successful completion, the island stashes the order intent into
 *     `sessionStorage` keyed by `mt.orderIntent.<id>` so the confirmation
 *     page can render the summary without a server round-trip, and clears
 *     the cart through `useCart().clear()`.
 *
 * Guest flow:
 *
 *   - v0.1 requires a customer (the API rejects guest addresses with
 *     `guest_address_unsupported`). The island reads a `mt.customerId`
 *     localStorage entry as the stand-in for the future auth session;
 *     when missing it shows the guest-unsupported message and a future
 *     "sign up" link. This keeps the gap honest until customer-auth lands.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import {
  ApiError,
  createClient,
  type Checkout,
  type CompleteCheckoutResult,
  type CustomerAddress,
  type MtCommerceClient,
  type ShippingMethod,
} from "@mt-commerce/sdk";
import { CartProvider, useCart } from "./CartProvider.js";
import { resolveApiUrl } from "../lib/api.js";

const ORDER_INTENT_STORAGE_PREFIX = "mt.orderIntent.";
const CUSTOMER_ID_STORAGE_KEY = "mt.customerId";

/** Single payment option for v0.1; the API gates the rest. */
const PAYMENT_METHOD = "manual_bank_transfer";

type Step = "address" | "shipping" | "payment" | "review";
const STEP_ORDER: readonly Step[] = ["address", "shipping", "payment", "review"];

export type CheckoutFlowProps = {
  /** BCP47 (e.g. "id-ID") — used by `Intl.NumberFormat`. */
  locale: string;
  /** Short locale (e.g. "id") — used for SDK calls and i18n lookups. */
  apiLocale: "id" | "en";
  /** Path to the cart page when the cart is empty. */
  cartHref: string;
  /** Path to the home/products listing for the empty-cart CTA. */
  productsHref: string;
  /** Locale-aware path used to navigate to the confirmation page. */
  confirmedHrefPattern: string;
  /** All UI labels travel as props so the island stays locale-independent. */
  labels: CheckoutLabels;
};

export type CheckoutLabels = {
  pageTitle: string;
  loading: string;
  emptyCart: string;
  emptyCartCta: string;
  steps: {
    address: string;
    shipping: string;
    payment: string;
    review: string;
  };
  address: {
    title: string;
    selectExisting: string;
    addNew: string;
    addNewHint: string;
    billingSame: string;
    billingDifferent: string;
    billingSelect: string;
    continueLabel: string;
    empty: string;
    guestUnsupported: string;
    guestSignup: string;
  };
  shipping: {
    title: string;
    selectMethod: string;
    empty: string;
    continueLabel: string;
  };
  payment: {
    title: string;
    manualBankTransfer: string;
    manualBankTransferNote: string;
    continueLabel: string;
  };
  review: {
    title: string;
    confirm: string;
    confirming: string;
    addressLabel: string;
    billingLabel: string;
    shippingLabel: string;
    paymentLabel: string;
    itemsLabel: string;
    edit: string;
  };
  totals: {
    subtotal: string;
    tax: string;
    shipping: string;
    total: string;
  };
  errors: {
    generic: string;
    unknownStep: string;
    idempotencyConflict: string;
  };
};

/** Generate an idempotency key — UUIDv4 from the platform crypto API. */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Defensive fallback for older runtimes; the storefront targets modern
  // browsers but a polyfill keeps the surface non-throwing.
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readCustomerIdStandIn(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(CUSTOMER_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistOrderIntentHandoff(
  orderIntentId: string,
  result: CompleteCheckoutResult,
): void {
  if (typeof window === "undefined") return;
  try {
    // The OrderIntent is JSON-stringifiable except for `Money` (bigint) and
    // `Date` instances. We re-serialize to plain JSON so the confirmation
    // page can rehydrate without the SDK.
    const serializable = {
      checkoutId: result.checkout.id,
      orderIntent: {
        id: result.orderIntent.id,
        email: result.orderIntent.email,
        shippingMethodCode: result.orderIntent.shippingMethodCode,
        paymentMethod: result.orderIntent.paymentMethod,
        cartSnapshot: result.orderIntent.cartSnapshot.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: {
            amount: line.unitPrice.amount.toString(),
            currency: line.unitPrice.currency,
          },
        })),
        totalsSnapshot: {
          subtotal: serializeMoney(result.orderIntent.totalsSnapshot.subtotal),
          tax: serializeMoney(result.orderIntent.totalsSnapshot.tax),
          shipping: serializeMoney(result.orderIntent.totalsSnapshot.shipping),
          total: serializeMoney(result.orderIntent.totalsSnapshot.total),
        },
        shippingAddressSnapshot: result.orderIntent.shippingAddressSnapshot,
        billingAddressSnapshot: result.orderIntent.billingAddressSnapshot,
      },
    };
    window.sessionStorage.setItem(
      `${ORDER_INTENT_STORAGE_PREFIX}${orderIntentId}`,
      JSON.stringify(serializable),
    );
  } catch {
    // sessionStorage may be disabled — confirmation page falls back to a
    // minimal "thank you" without the line items.
  }
}

function serializeMoney(money: Money): { amount: string; currency: string } {
  return { amount: money.amount.toString(), currency: money.currency };
}

function formatAddressLine(address: CustomerAddress): string {
  return [address.addressLine1, address.addressLine2].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------------------
// Step header — clickable breadcrumb of the four steps.
// ---------------------------------------------------------------------------

interface StepNavProps {
  currentStep: Step;
  reachedSteps: ReadonlySet<Step>;
  labels: CheckoutLabels["steps"];
  onStepClick: (step: Step) => void;
}

function StepNav({ currentStep, reachedSteps, labels, onStepClick }: StepNavProps) {
  return (
    <nav aria-label="Checkout steps" className="border-b border-line">
      <ol className="mx-auto flex max-w-[1100px] items-center gap-3 px-5 py-5 t-caption md:gap-6 md:px-8">
        {STEP_ORDER.map((step, idx) => {
          const isCurrent = step === currentStep;
          const isReached = reachedSteps.has(step);
          const label = labels[step];
          return (
            <li key={step} className="flex items-center gap-3 md:gap-6">
              {idx > 0 && (
                <span aria-hidden="true" className="text-faint">
                  /
                </span>
              )}
              {isReached && !isCurrent ? (
                <button
                  type="button"
                  onClick={() => onStepClick(step)}
                  className="lowercase tracking-[0.05em] text-muted transition-colors duration-150 hover:text-accent"
                >
                  {label}
                </button>
              ) : (
                <span
                  aria-current={isCurrent ? "step" : undefined}
                  className={
                    isCurrent
                      ? "lowercase tracking-[0.05em] text-fg"
                      : "lowercase tracking-[0.05em] text-faint"
                  }
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Address
// ---------------------------------------------------------------------------

interface AddressStepProps {
  customerId: string | null;
  client: MtCommerceClient;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  onSelect: (shippingAddressId: string, billingAddressId: string | null) => void;
  busy: boolean;
  error: string | null;
  labels: CheckoutLabels["address"];
  buttonLabel: string;
}

function AddressStep({
  customerId,
  client,
  shippingAddressId,
  billingAddressId,
  onSelect,
  busy,
  error,
  labels,
  buttonLabel,
}: AddressStepProps) {
  const [addresses, setAddresses] = useState<CustomerAddress[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shipId, setShipId] = useState<string | null>(shippingAddressId);
  const [billDifferent, setBillDifferent] = useState<boolean>(
    billingAddressId !== null && billingAddressId !== shippingAddressId,
  );
  const [billId, setBillId] = useState<string | null>(billingAddressId);

  useEffect(() => {
    if (!customerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.customer.myAddresses({ customerId });
        if (cancelled) return;
        setAddresses(list);
        // Prefer default shipping; otherwise the first address.
        if (!shipId) {
          const preferred =
            list.find((a) => a.isDefaultShipping) ?? list[0] ?? null;
          if (preferred) setShipId(preferred.id);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "address_load_failed",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, customerId, shipId]);

  if (!customerId) {
    return (
      <section className="space-y-6">
        <header>
          <h2 className="t-h1 text-fg">{labels.title}</h2>
        </header>
        <div className="border border-line bg-paper p-6">
          <p className="t-body text-muted">{labels.guestUnsupported}</p>
          {/* TODO: /signup route does not exist yet. The link is left active
              so the visual slot is in place once the auth integration lands. */}
          <a
            href="#"
            aria-disabled="true"
            className="mt-3 inline-flex t-body text-faint"
          >
            {labels.guestSignup}
          </a>
        </div>
      </section>
    );
  }

  const canContinue =
    !busy && !loading && shipId !== null && (!billDifferent || billId !== null);

  return (
    <section className="space-y-6">
      <header>
        <h2 className="t-h1 text-fg">{labels.title}</h2>
      </header>

      {loading ? (
        <div className="h-32 w-full skeleton" aria-busy="true" />
      ) : loadError ? (
        <p role="alert" className="t-body text-danger">
          {loadError}
        </p>
      ) : !addresses || addresses.length === 0 ? (
        <div className="border border-line bg-paper p-6">
          <p className="t-body text-muted">{labels.empty}</p>
          <p className="mt-2 t-caption text-faint">{labels.addNewHint}</p>
        </div>
      ) : (
        <fieldset className="space-y-3">
          <legend className="t-caption text-muted">{labels.selectExisting}</legend>
          {addresses.map((address) => (
            <AddressRadioCard
              key={address.id}
              address={address}
              name="shipping-address"
              selected={shipId === address.id}
              onChange={() => setShipId(address.id)}
            />
          ))}
        </fieldset>
      )}

      {addresses && addresses.length > 0 && (
        <div className="space-y-3">
          <label className="flex items-center gap-3 t-body text-fg">
            <input
              type="checkbox"
              checked={billDifferent}
              onChange={(e) => {
                const next = e.target.checked;
                setBillDifferent(next);
                if (!next) setBillId(null);
              }}
              className="h-4 w-4 border-line accent-accent"
            />
            {labels.billingDifferent}
          </label>
          {billDifferent && (
            <fieldset className="space-y-3 border-t border-line pt-4">
              <legend className="t-caption text-muted">{labels.billingSelect}</legend>
              {addresses.map((address) => (
                <AddressRadioCard
                  key={`bill-${address.id}`}
                  address={address}
                  name="billing-address"
                  selected={billId === address.id}
                  onChange={() => setBillId(address.id)}
                />
              ))}
            </fieldset>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="t-caption text-danger">
          {error}
        </p>
      )}

      <div className="pt-2">
        <button
          type="button"
          onClick={() => {
            if (!shipId) return;
            onSelect(shipId, billDifferent ? billId : null);
          }}
          disabled={!canContinue}
          aria-busy={busy}
          className="btn-primary w-full md:w-auto md:px-12"
        >
          {busy ? "…" : buttonLabel}
        </button>
      </div>
    </section>
  );
}

interface AddressRadioCardProps {
  address: CustomerAddress;
  name: string;
  selected: boolean;
  onChange: () => void;
}

function AddressRadioCard({ address, name, selected, onChange }: AddressRadioCardProps) {
  return (
    <label
      className={
        "flex cursor-pointer items-start gap-4 border bg-paper p-5 transition-colors duration-150 " +
        (selected ? "border-line-strong" : "border-line hover:border-fg")
      }
    >
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onChange}
        className="mt-1 h-4 w-4 accent-accent"
      />
      <div className="flex-1 space-y-1">
        <p className="t-body text-fg">{address.recipientName}</p>
        <p className="t-caption text-muted">{formatAddressLine(address)}</p>
        <p className="t-caption text-muted">
          {address.kotaKabupatenId} · {address.postalCode}
        </p>
        <p className="t-caption text-faint">{address.phone}</p>
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Shipping
// ---------------------------------------------------------------------------

interface ShippingStepProps {
  client: MtCommerceClient;
  currency: string;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  busy: boolean;
  error: string | null;
  locale: string;
  labels: CheckoutLabels["shipping"];
  buttonLabel: string;
}

function ShippingStep({
  client,
  currency,
  selectedCode,
  onSelect,
  busy,
  error,
  locale,
  labels,
  buttonLabel,
}: ShippingStepProps) {
  const [methods, setMethods] = useState<ShippingMethod[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosenCode, setChosenCode] = useState<string | null>(selectedCode);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.shipping.methods({ currency });
        if (cancelled) return;
        setMethods(list);
        if (!chosenCode && list.length > 0) {
          setChosenCode(list[0]!.code);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "shipping_load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, currency, chosenCode]);

  return (
    <section className="space-y-6">
      <header>
        <h2 className="t-h1 text-fg">{labels.title}</h2>
      </header>

      {loading ? (
        <div className="h-24 w-full skeleton" aria-busy="true" />
      ) : loadError ? (
        <p role="alert" className="t-body text-danger">
          {loadError}
        </p>
      ) : !methods || methods.length === 0 ? (
        <div className="border border-line bg-paper p-6">
          <p className="t-body text-muted">{labels.empty}</p>
        </div>
      ) : (
        <fieldset className="space-y-3">
          <legend className="t-caption text-muted">{labels.selectMethod}</legend>
          {methods.map((method) => (
            <label
              key={method.id}
              className={
                "flex cursor-pointer items-start gap-4 border bg-paper p-5 transition-colors duration-150 " +
                (chosenCode === method.code
                  ? "border-line-strong"
                  : "border-line hover:border-fg")
              }
            >
              <input
                type="radio"
                name="shipping-method"
                checked={chosenCode === method.code}
                onChange={() => setChosenCode(method.code)}
                className="mt-1 h-4 w-4 accent-accent"
              />
              <div className="flex flex-1 items-center justify-between gap-4">
                <span className="t-body text-fg">{method.name}</span>
                <span className="price-figure t-body text-fg">
                  {method.flatRate ? formatMoney(method.flatRate, { locale }) : "—"}
                </span>
              </div>
            </label>
          ))}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="t-caption text-danger">
          {error}
        </p>
      )}

      <div className="pt-2">
        <button
          type="button"
          onClick={() => {
            if (!chosenCode) return;
            onSelect(chosenCode);
          }}
          disabled={busy || !chosenCode}
          aria-busy={busy}
          className="btn-primary w-full md:w-auto md:px-12"
        >
          {busy ? "…" : buttonLabel}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Payment (UI-only at v0.1)
// ---------------------------------------------------------------------------

interface PaymentStepProps {
  onContinue: () => void;
  labels: CheckoutLabels["payment"];
}

function PaymentStep({ onContinue, labels }: PaymentStepProps) {
  return (
    <section className="space-y-6">
      <header>
        <h2 className="t-h1 text-fg">{labels.title}</h2>
      </header>
      <fieldset className="space-y-3">
        <label className="flex items-start gap-4 border border-line-strong bg-paper p-5">
          <input
            type="radio"
            name="payment-method"
            checked
            readOnly
            className="mt-1 h-4 w-4 accent-accent"
          />
          <div className="flex-1 space-y-2">
            <p className="t-body text-fg">{labels.manualBankTransfer}</p>
            <p className="t-caption text-muted">{labels.manualBankTransferNote}</p>
          </div>
        </label>
      </fieldset>
      <div className="pt-2">
        <button
          type="button"
          onClick={onContinue}
          className="btn-primary w-full md:w-auto md:px-12"
        >
          {labels.continueLabel}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Review and confirm — the idempotent submission step.
// ---------------------------------------------------------------------------

interface ReviewStepProps {
  cart: NonNullable<ReturnType<typeof useCart>["cart"]>;
  shippingAddress: CustomerAddress | null;
  billingAddress: CustomerAddress | null;
  shippingMethod: ShippingMethod | null;
  shippingAmount: Money | null;
  onConfirm: () => Promise<void>;
  onEdit: (step: Step) => void;
  busy: boolean;
  error: string | null;
  locale: string;
  labels: CheckoutLabels;
}

function ReviewStep({
  cart,
  shippingAddress,
  billingAddress,
  shippingMethod,
  shippingAmount,
  onConfirm,
  onEdit,
  busy,
  error,
  locale,
  labels,
}: ReviewStepProps) {
  const total = useMemo<Money>(() => {
    if (!shippingAmount) return cart.totals.total;
    return {
      amount: cart.totals.subtotal.amount + cart.totals.tax.amount + shippingAmount.amount,
      currency: cart.totals.total.currency,
    };
  }, [cart, shippingAmount]);

  return (
    <section className="space-y-8">
      <header>
        <h2 className="t-h1 text-fg">{labels.review.title}</h2>
      </header>

      <ReviewBlock
        title={labels.review.addressLabel}
        editLabel={labels.review.edit}
        onEdit={() => onEdit("address")}
      >
        {shippingAddress ? (
          <>
            <p className="t-body text-fg">{shippingAddress.recipientName}</p>
            <p className="t-caption text-muted">{formatAddressLine(shippingAddress)}</p>
            <p className="t-caption text-muted">
              {shippingAddress.kotaKabupatenId} · {shippingAddress.postalCode}
            </p>
            <p className="t-caption text-faint">{shippingAddress.phone}</p>
          </>
        ) : (
          <p className="t-caption text-muted">—</p>
        )}
      </ReviewBlock>

      {billingAddress && billingAddress.id !== shippingAddress?.id && (
        <ReviewBlock
          title={labels.review.billingLabel}
          editLabel={labels.review.edit}
          onEdit={() => onEdit("address")}
        >
          <p className="t-body text-fg">{billingAddress.recipientName}</p>
          <p className="t-caption text-muted">{formatAddressLine(billingAddress)}</p>
        </ReviewBlock>
      )}

      <ReviewBlock
        title={labels.review.shippingLabel}
        editLabel={labels.review.edit}
        onEdit={() => onEdit("shipping")}
      >
        <div className="flex items-center justify-between">
          <p className="t-body text-fg">{shippingMethod?.name ?? "—"}</p>
          <p className="price-figure t-body text-fg">
            {shippingAmount ? formatMoney(shippingAmount, { locale }) : "—"}
          </p>
        </div>
      </ReviewBlock>

      <ReviewBlock
        title={labels.review.paymentLabel}
        editLabel={labels.review.edit}
        onEdit={() => onEdit("payment")}
      >
        <p className="t-body text-fg">{labels.payment.manualBankTransfer}</p>
        <p className="t-caption text-muted">{labels.payment.manualBankTransferNote}</p>
      </ReviewBlock>

      <div className="border-t border-line pt-6">
        <h3 className="t-caption text-muted">{labels.review.itemsLabel}</h3>
        <ul className="mt-3 divide-y divide-line">
          {cart.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 py-4">
              <div className="space-y-1">
                <p className="t-body text-fg">{item.variantId}</p>
                <p className="t-caption text-muted">× {item.quantity}</p>
              </div>
              <p className="price-figure t-body text-fg">
                {formatMoney(item.lineTotal, { locale })}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <dl className="space-y-2 border-t border-line pt-6 t-body">
        <div className="flex justify-between text-muted">
          <dt>{labels.totals.subtotal}</dt>
          <dd className="price-figure">{formatMoney(cart.totals.subtotal, { locale })}</dd>
        </div>
        <div className="flex justify-between text-muted">
          <dt>{labels.totals.tax}</dt>
          <dd className="price-figure">{formatMoney(cart.totals.tax, { locale })}</dd>
        </div>
        <div className="flex justify-between text-muted">
          <dt>{labels.totals.shipping}</dt>
          <dd className="price-figure">
            {shippingAmount ? formatMoney(shippingAmount, { locale }) : "—"}
          </dd>
        </div>
        <div className="flex justify-between border-t border-line pt-3 text-fg">
          <dt>{labels.totals.total}</dt>
          <dd className="price-figure">{formatMoney(total, { locale })}</dd>
        </div>
      </dl>

      {error && (
        <p role="alert" className="t-caption text-danger">
          {error}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={busy}
          aria-busy={busy}
          className="btn-primary w-full md:w-auto md:px-12"
        >
          {busy ? labels.review.confirming : labels.review.confirm}
        </button>
      </div>
    </section>
  );
}

interface ReviewBlockProps {
  title: string;
  editLabel: string;
  onEdit: () => void;
  children: React.ReactNode;
}

function ReviewBlock({ title, editLabel, onEdit, children }: ReviewBlockProps) {
  return (
    <div className="border border-line bg-paper p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="t-caption text-muted">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
        >
          {editLabel}
        </button>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outer flow — owns the API state machine, drives the steps.
// ---------------------------------------------------------------------------

function CheckoutFlowInner(props: CheckoutFlowProps) {
  const { locale, apiLocale, productsHref, confirmedHrefPattern, labels } = props;
  const { cart, loading: cartLoading, clear: clearCart } = useCart();
  const client = useMemo<MtCommerceClient>(
    () => createClient({ baseUrl: resolveApiUrl(), locale: apiLocale }),
    [apiLocale],
  );

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("address");
  const [reachedSteps, setReachedSteps] = useState<Set<Step>>(new Set(["address"]));
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // The signed-in customer's saved address list — fetched once, shared across
  // the address step and the review step (so we can render the picked address
  // without a second round-trip).
  const [addressBook, setAddressBook] = useState<CustomerAddress[]>([]);
  const [shippingMethods, setShippingMethods] = useState<ShippingMethod[]>([]);

  // The idempotency key is generated when the user arrives at the review
  // step and reused on every retry — that's the whole point.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setCustomerId(readCustomerIdStandIn());
  }, []);

  const ensureCheckout = useCallback(async (): Promise<Checkout | null> => {
    if (checkout) return checkout;
    if (!cart) return null;
    const created = await client.storefront.checkout.start({ cartId: cart.id });
    setCheckout(created);
    return created;
  }, [cart, checkout, client]);

  const goToStep = useCallback((next: Step) => {
    setStep(next);
    setStepError(null);
    setReachedSteps((prev) => {
      const out = new Set(prev);
      out.add(next);
      return out;
    });
    if (next !== "review") {
      // Editing earlier steps means the body would change, so the key on a
      // future submit must be fresh. Resetting here keeps the headline
      // guarantee honest: same body + same key = same response.
      idempotencyKeyRef.current = null;
    }
  }, []);

  const handleAddressContinue = useCallback(
    async (shippingAddressId: string, billingAddressId: string | null) => {
      setBusy(true);
      setStepError(null);
      try {
        const c = await ensureCheckout();
        if (!c) return;
        const updated = await client.storefront.checkout.setAddresses(c.id, {
          shippingAddressId,
          ...(billingAddressId !== null ? { billingAddressId } : {}),
        });
        setCheckout(updated);
        goToStep("shipping");
      } catch (err) {
        setStepError(err instanceof ApiError ? err.message : labels.errors.generic);
      } finally {
        setBusy(false);
      }
    },
    [client, ensureCheckout, goToStep, labels.errors.generic],
  );

  const handleShippingContinue = useCallback(
    async (shippingMethodCode: string) => {
      if (!checkout) return;
      setBusy(true);
      setStepError(null);
      try {
        const updated = await client.storefront.checkout.setShipping(checkout.id, {
          shippingMethodCode,
        });
        setCheckout(updated);
        goToStep("payment");
      } catch (err) {
        setStepError(err instanceof ApiError ? err.message : labels.errors.generic);
      } finally {
        setBusy(false);
      }
    },
    [checkout, client, goToStep, labels.errors.generic],
  );

  const handlePaymentContinue = useCallback(() => {
    goToStep("review");
  }, [goToStep]);

  // Lazy-cache the address list and shipping methods so the review step can
  // render labels and amounts without re-fetching. We piggyback on the same
  // SDK calls the steps already make.
  useEffect(() => {
    if (!customerId || addressBook.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await client.storefront.customer.myAddresses({ customerId });
        if (!cancelled) setAddressBook(list);
      } catch {
        // Silent — the address step renders the same error inline.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, customerId, addressBook.length]);

  useEffect(() => {
    if (shippingMethods.length > 0 || !cart) return;
    let cancelled = false;
    void (async () => {
      try {
        const methods = await client.storefront.shipping.methods({
          currency: cart.currency,
        });
        if (!cancelled) setShippingMethods(methods);
      } catch {
        // The shipping step surfaces the failure when the user reaches it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cart, client, shippingMethods.length]);

  const shippingAddress = useMemo(
    () =>
      checkout?.shippingAddressId
        ? (addressBook.find((a) => a.id === checkout.shippingAddressId) ?? null)
        : null,
    [addressBook, checkout],
  );
  const billingAddress = useMemo(
    () =>
      checkout?.billingAddressId
        ? (addressBook.find((a) => a.id === checkout.billingAddressId) ?? null)
        : null,
    [addressBook, checkout],
  );
  const shippingMethod = useMemo(
    () =>
      checkout?.shippingMethodCode
        ? (shippingMethods.find((m) => m.code === checkout.shippingMethodCode) ??
          null)
        : null,
    [checkout, shippingMethods],
  );

  const handleConfirm = useCallback(async () => {
    if (!checkout || !cart) return;
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = newIdempotencyKey();
    }
    setBusy(true);
    setStepError(null);
    try {
      const result = await client.storefront.checkout.complete(checkout.id, {
        paymentMethod: PAYMENT_METHOD,
        idempotencyKey: idempotencyKeyRef.current,
      });
      // Hand the order intent to the confirmation page via sessionStorage,
      // empty the local cart, and navigate.
      persistOrderIntentHandoff(result.orderIntent.id, result);
      try {
        await clearCart();
      } catch {
        // The order is already placed; cart-clear failure is cosmetic.
      }
      const href = confirmedHrefPattern.replace(
        ":id",
        encodeURIComponent(result.orderIntent.id),
      );
      window.location.assign(href);
    } catch (err) {
      if (err instanceof ApiError && err.code === "idempotency_key_reuse") {
        // Backstop — body changed mid-flight. Reset the key and let the user
        // try again with a fresh one.
        idempotencyKeyRef.current = null;
        setStepError(labels.errors.idempotencyConflict);
      } else if (err instanceof ApiError) {
        setStepError(err.message);
      } else {
        setStepError(labels.errors.generic);
      }
    } finally {
      setBusy(false);
    }
  }, [
    cart,
    checkout,
    client,
    clearCart,
    confirmedHrefPattern,
    labels.errors.generic,
    labels.errors.idempotencyConflict,
  ]);

  // ---- Gate ---------------------------------------------------------------
  if (cartLoading && !cart) {
    return (
      <div className="mx-auto max-w-[1100px] px-5 py-16 md:px-8" aria-busy="true">
        <div className="h-9 w-48 skeleton" />
        <div className="mt-10 h-32 w-full skeleton" />
      </div>
    );
  }

  if (!cart || cart.items.length === 0) {
    return (
      <div className="mx-auto max-w-[1100px] px-5 py-24 md:px-8">
        <h1 className="t-display text-fg">{labels.pageTitle}</h1>
        <p className="mt-6 t-body text-muted">{labels.emptyCart}</p>
        <a
          href={productsHref}
          className="mt-4 inline-flex t-body text-fg underline-offset-[6px] transition-colors duration-150 hover:text-accent hover:underline"
        >
          {labels.emptyCartCta} &rarr;
        </a>
      </div>
    );
  }

  return (
    <div className="pb-32">
      <StepNav
        currentStep={step}
        reachedSteps={reachedSteps}
        labels={labels.steps}
        onStepClick={goToStep}
      />

      <div className="mx-auto grid max-w-[1100px] gap-12 px-5 pt-12 md:grid-cols-[1fr_320px] md:gap-16 md:px-8 md:pt-16">
        <div>
          {step === "address" ? (
            <AddressStep
              customerId={customerId}
              client={client}
              shippingAddressId={checkout?.shippingAddressId ?? null}
              billingAddressId={checkout?.billingAddressId ?? null}
              onSelect={(s, b) => void handleAddressContinue(s, b)}
              busy={busy}
              error={stepError}
              labels={labels.address}
              buttonLabel={labels.address.continueLabel}
            />
          ) : step === "shipping" ? (
            <ShippingStep
              client={client}
              currency={cart.currency}
              selectedCode={checkout?.shippingMethodCode ?? null}
              onSelect={(code) => void handleShippingContinue(code)}
              busy={busy}
              error={stepError}
              locale={locale}
              labels={labels.shipping}
              buttonLabel={labels.shipping.continueLabel}
            />
          ) : step === "payment" ? (
            <PaymentStep onContinue={handlePaymentContinue} labels={labels.payment} />
          ) : step === "review" ? (
            <ReviewStep
              cart={cart}
              shippingAddress={shippingAddress}
              billingAddress={billingAddress}
              shippingMethod={shippingMethod}
              shippingAmount={checkout?.shippingAmount ?? null}
              onConfirm={handleConfirm}
              onEdit={goToStep}
              busy={busy}
              error={stepError}
              locale={locale}
              labels={labels}
            />
          ) : (
            <p role="alert" className="t-body text-danger">
              {labels.errors.unknownStep}
            </p>
          )}

          {step !== "address" && step !== "review" && (
            <button
              type="button"
              onClick={() =>
                goToStep(STEP_ORDER[Math.max(0, STEP_ORDER.indexOf(step) - 1)]!)
              }
              className="mt-8 inline-flex items-center gap-2 t-caption text-muted transition-colors duration-150 hover:text-accent"
            >
              <HugeiconsIcon
                icon={ArrowLeft02Icon}
                size={14}
                strokeWidth={1.5}
                aria-hidden
              />
              {labels.steps[STEP_ORDER[Math.max(0, STEP_ORDER.indexOf(step) - 1)]!]}
            </button>
          )}
        </div>

        <aside className="border-t border-line pt-8 md:border-l md:border-t-0 md:pl-8 md:pt-0">
          <h2 className="t-caption text-muted">{labels.totals.total}</h2>
          <dl className="mt-4 space-y-2 t-body">
            <div className="flex justify-between text-muted">
              <dt>{labels.totals.subtotal}</dt>
              <dd className="price-figure">
                {formatMoney(cart.totals.subtotal, { locale })}
              </dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>{labels.totals.tax}</dt>
              <dd className="price-figure">{formatMoney(cart.totals.tax, { locale })}</dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>{labels.totals.shipping}</dt>
              <dd className="price-figure">
                {checkout?.shippingAmount
                  ? formatMoney(checkout.shippingAmount, { locale })
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-3 text-fg">
              <dt>{labels.totals.total}</dt>
              <dd className="price-figure">
                {checkout?.shippingAmount
                  ? formatMoney(
                      {
                        amount:
                          cart.totals.subtotal.amount +
                          cart.totals.tax.amount +
                          checkout.shippingAmount.amount,
                        currency: cart.totals.total.currency,
                      },
                      { locale },
                    )
                  : formatMoney(cart.totals.total, { locale })}
              </dd>
            </div>
          </dl>
          {checkout?.state === "completed" && (
            <p className="mt-6 inline-flex items-center gap-2 t-caption text-success">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={14}
                strokeWidth={1.5}
                aria-hidden
              />
              {labels.steps.review}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function CheckoutFlow(props: CheckoutFlowProps) {
  return (
    <CartProvider>
      <CheckoutFlowInner {...props} />
    </CartProvider>
  );
}
