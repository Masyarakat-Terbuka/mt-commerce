/**
 * Settings routes — auth/role enforcement and happy-path smoke tests.
 *
 * Same pattern as the customer/tax route tests: spy `authService` so the
 * real Better Auth handler never runs, inject a hand-crafted
 * `SettingsService`, and assert at the HTTP boundary.
 *
 * What we pin:
 *   - Anonymous → 401
 *   - Viewer role → 403 (settings is mutating)
 *   - Staff/admin/owner → 200
 *   - PATCH validates: empty body → 400, unknown locale → 400
 *   - PATCH success returns the updated wire shape
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildSettingsAdminRoutes } from "../../../src/modules/settings/routes/admin.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  SettingsService,
  StoreSettings,
} from "../../../src/modules/settings/index.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

const STAFF_USER = {
  id: "usr_staff",
  email: "staff@example.com",
  emailVerified: true,
  name: "Staff",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VIEWER_USER = {
  id: "usr_viewer",
  email: "viewer@example.com",
  emailVerified: true,
  name: "Viewer",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.spyOn(authService, "verifyApiKey").mockImplementation(async (bearer) => {
    if (bearer === "staff-key") {
      return {
        apiKey: {
          id: "apik_staff",
          userId: STAFF_USER.id,
          name: "test",
          scopes: [],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: STAFF_USER,
      };
    }
    if (bearer === "viewer-key") {
      return {
        apiKey: {
          id: "apik_viewer",
          userId: VIEWER_USER.id,
          name: "test",
          scopes: [],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: VIEWER_USER,
      };
    }
    return null;
  });
  vi.spyOn(authService, "getStaffProfile").mockImplementation(async (id) => {
    if (id === STAFF_USER.id) {
      return {
        authUserId: STAFF_USER.id,
        role: "admin",
        displayName: "Staff",
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
    if (id === VIEWER_USER.id) {
      return {
        authUserId: VIEWER_USER.id,
        role: "viewer",
        displayName: "Viewer",
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
    return null;
  });
});

function makeSettings(overrides: Partial<StoreSettings> = {}): StoreSettings {
  return {
    storeName: "mt-commerce",
    defaultCurrency: "IDR",
    defaultLocale: "id",
    defaultTaxRateId: null,
    shippingOriginProvinsiId: null,
    shippingOriginKotaKabupatenId: null,
    shippingOriginKecamatanId: null,
    shippingOriginKelurahanId: null,
    shippingOriginPostalCode: null,
    shippingOriginAddressLine1: null,
    shippingOriginPhone: null,
    notificationEmailEnabled: true,
    notificationWhatsappEnabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createFakeService(initial?: StoreSettings): SettingsService {
  let state: StoreSettings = initial ?? makeSettings();
  return {
    async getSettings() {
      return state;
    },
    async updateSettings(patch) {
      state = makeSettings({
        ...state,
        ...(patch.storeName !== undefined ? { storeName: patch.storeName } : {}),
        ...(patch.defaultCurrency !== undefined
          ? { defaultCurrency: patch.defaultCurrency }
          : {}),
        ...(patch.defaultLocale !== undefined
          ? { defaultLocale: patch.defaultLocale }
          : {}),
        ...(patch.notificationEmailEnabled !== undefined
          ? { notificationEmailEnabled: patch.notificationEmailEnabled }
          : {}),
        ...(patch.notificationWhatsappEnabled !== undefined
          ? { notificationWhatsappEnabled: patch.notificationWhatsappEnabled }
          : {}),
      });
      return state;
    },
  };
}

function buildApp(service: SettingsService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildSettingsAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

describe("admin settings routes — auth gating", () => {
  it("rejects anonymous GET with 401", async () => {
    const app = buildApp(createFakeService());
    const res = await app.request("/admin/v1/settings");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects viewer role with 403", async () => {
    const app = buildApp(createFakeService());
    const res = await app.request("/admin/v1/settings", {
      headers: { authorization: "Bearer viewer-key" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("admits staff and returns the wire shape", async () => {
    const app = buildApp(
      createFakeService(
        makeSettings({ storeName: "Toko Kopi", notificationWhatsappEnabled: true }),
      ),
    );
    const res = await app.request("/admin/v1/settings", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storeName: string;
      defaultCurrency: string;
      notificationWhatsappEnabled: boolean;
    };
    expect(body.storeName).toBe("Toko Kopi");
    expect(body.defaultCurrency).toBe("IDR");
    expect(body.notificationWhatsappEnabled).toBe(true);
  });
});

describe("admin settings routes — PATCH", () => {
  it("400s on an empty body", async () => {
    const app = buildApp(createFakeService());
    const res = await app.request("/admin/v1/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("400s on an unknown locale", async () => {
    const app = buildApp(createFakeService());
    const res = await app.request("/admin/v1/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({ defaultLocale: "fr" }),
    });
    expect(res.status).toBe(400);
  });

  it("happy path: returns the patched wire shape", async () => {
    const app = buildApp(createFakeService());
    const res = await app.request("/admin/v1/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({
        storeName: "Toko Baru",
        notificationWhatsappEnabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storeName: string;
      notificationWhatsappEnabled: boolean;
      notificationEmailEnabled: boolean;
    };
    expect(body.storeName).toBe("Toko Baru");
    expect(body.notificationWhatsappEnabled).toBe(true);
    // Untouched key keeps its prior value.
    expect(body.notificationEmailEnabled).toBe(true);
  });
});
