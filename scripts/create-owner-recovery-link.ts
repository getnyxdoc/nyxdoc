import { sqlite } from "@/lib/db/client";
import {
  createPasswordRecoveryLink,
  ensureSiteAdministratorBootstrap,
} from "@/lib/site-settings/service";

const owner = sqlite.prepare(
  `SELECT u.id, u.name, u.email
   FROM site_administrators a
   JOIN user u ON u.id = a.user_id
   WHERE a.role = 'owner'
   LIMIT 1`,
).get() as { id: string; name: string; email: string } | undefined;

if (!owner) {
  ensureSiteAdministratorBootstrap(sqlite);
}

const resolvedOwner = owner ?? sqlite.prepare(
  `SELECT u.id, u.name, u.email
   FROM site_administrators a
   JOIN user u ON u.id = a.user_id
   WHERE a.role = 'owner'
   LIMIT 1`,
).get() as { id: string; name: string; email: string } | undefined;

if (!resolvedOwner) {
  throw new Error("No site owner exists. Complete the first-owner setup in the browser first.");
}

const result = createPasswordRecoveryLink(
  sqlite,
  resolvedOwner,
  resolvedOwner.id,
);

console.log("Nyxdoc owner password recovery link (valid for 30 minutes):");
console.log(result.url);
sqlite.close();
