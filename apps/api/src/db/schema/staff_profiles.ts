/**
 * Staff profile — the domain marker that turns an `auth_users` identity into a
 * staff member. Per ADR-0005 and the auth module's "Option A" decision (single
 * Better Auth user table, parallel domain profile tables for staff and
 * customers), the existence of a row here means "this auth user is staff".
 *
 * The `role` enum drives admin authorization. The set is fixed for v0.1; new
 * roles ship as additive enum migrations.
 *
 * `auth_user_id` is both the primary key and the FK — a one-to-one link with
 * cascade delete so removing the auth identity removes the staff binding
 * automatically. This intentionally does NOT cascade in the other direction:
 * deleting a staff_profile does not remove the underlying auth user (they may
 * still be a customer; revocation is handled at the auth layer).
 */
import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const staffRole = pgEnum("staff_role", [
  "owner",
  "admin",
  "staff",
  "viewer",
]);

export const staffProfiles = pgTable("staff_profiles", {
  authUserId: text("auth_user_id")
    .primaryKey()
    .references((): AnyPgColumn => authUsers.id, { onDelete: "cascade" }),
  role: staffRole("role").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type StaffProfileRow = typeof staffProfiles.$inferSelect;
export type NewStaffProfileRow = typeof staffProfiles.$inferInsert;
