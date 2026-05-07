/**
 * CartDrawer — placeholder island.
 *
 * The cart module does not yet exist on the API. This component renders an
 * empty state and acts as the mount point for the real drawer once the cart
 * SDK lands. No state, no fetching.
 */
export type CartDrawerProps = {
  emptyLabel: string;
  titleLabel: string;
};

export default function CartDrawer({ emptyLabel, titleLabel }: CartDrawerProps) {
  return (
    <aside className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="text-base font-semibold text-neutral-900">{titleLabel}</h2>
      <p className="mt-2 text-sm text-neutral-600">{emptyLabel}</p>
    </aside>
  );
}
