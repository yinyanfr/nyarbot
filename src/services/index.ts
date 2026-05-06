/**
 * This file handles all network related functions
 */

import admin, { type ServiceAccount } from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json" with { type: "json" };

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as ServiceAccount),
});
