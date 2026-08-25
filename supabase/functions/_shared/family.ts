// Who the payer IS, and whose Stripe customer the card lands on.
//
// One module because five checkouts each had their own answer, and every
// wrong answer was a variation of the same sin: minting a fresh Stripe
// customer per sale and stamping it on a KID's contact row. The card belongs
// to the family's guardian (owner's locked model); a kid's own customer is
// legitimate only when the kid IS the payer - an adult paying for themselves.
//
// Rules, in order:
//   1. The payer's email matches exactly one CONTACT: an adult paying for
//      themselves. Their own customer is reused, or the new one is adopted
//      onto them (never overwriting - repointing a member's saved cards at a
//      stranger is the disaster this guard exists for).
//   2. The payer's email matches exactly one GUARDIAN: reuse her customer or
//      adopt the new one onto her, and make sure she is LINKED to the student
//      being paid for, so the family renders on the profile.
//   3. Nobody matches: the payer becomes a real guardians PERSON (name, email,
//      phone), linked to the student, holding the new customer. Before this,
//      enrollment checkouts wrote legacy name/email link rows with no guardian
//      person behind them - data the CRM's guardian UI cannot see.
//
// The student contact row is never stamped except in case 1, where the
// "student" is the payer themselves.

type Admin = {
  from: (t: string) => any;
};

export type FamilyCustomerResult = {
  custId: string;
  ownerKind: "contact" | "guardian" | "none";
  guardianId: string | null;
};

export async function findOrCreateGuardian(
  admin: Admin,
  args: { name: string; email: string; phone?: string; studentId?: string | null; label?: string },
): Promise<string | null> {
  const email = String(args.email || "").trim().toLowerCase();
  if (!email) return null;
  let guardianId: string | null = null;
  const gm = await admin.from("guardian_emails").select("guardian_id").ilike("email", email).limit(2);
  if ((gm.data ?? []).length === 1) {
    guardianId = gm.data![0].guardian_id as string;
  } else if ((gm.data ?? []).length === 0) {
    const gIns = await admin.from("guardians")
      .insert({ name: args.name || email, phones: args.phone ? [args.phone] : [] })
      .select("id").single();
    if (gIns.error || !gIns.data) { console.error("guardian create", gIns.error); return null; }
    guardianId = gIns.data.id as string;
    const eIns = await admin.from("guardian_emails").insert({ guardian_id: guardianId, email });
    if (eIns.error) console.error("guardian email", eIns.error);
  } else {
    return null; // two guardians share the address: refuse to guess
  }
  if (guardianId && args.studentId) {
    const linked = await admin.from("student_guardians").select("id")
      .eq("student_id", args.studentId).eq("guardian_id", guardianId).limit(1);
    if (!(linked.data ?? []).length) {
      // The legacy email column on the link table is NOT NULL.
      const lIns = await admin.from("student_guardians").insert({
        student_id: args.studentId, guardian_id: guardianId,
        label: args.label || "Guardian", email,
      });
      if (lIns.error) console.error("guardian link", lIns.error);
    }
  }
  return guardianId;
}

export async function familyCustomer(
  admin: Admin,
  stripeCall: (path: string, key: string, form: URLSearchParams) => Promise<any>,
  secretKey: string,
  args: { email: string; name: string; phone?: string; studentId?: string | null },
): Promise<FamilyCustomerResult> {
  const email = String(args.email || "").trim().toLowerCase();

  // 1. an adult paying for themselves
  const cm = await admin.from("contacts").select("id,stripe_customer_id").ilike("email", email).limit(2);
  if ((cm.data ?? []).length === 1) {
    const c = cm.data![0];
    if (c.stripe_customer_id) return { custId: c.stripe_customer_id, ownerKind: "contact", guardianId: null };
    const cust = await mint(stripeCall, secretKey, args, { contact_id: c.id });
    await admin.from("contacts").update({ stripe_customer_id: cust })
      .eq("id", c.id).is("stripe_customer_id", null);
    return { custId: cust, ownerKind: "contact", guardianId: null };
  }

  // 2 and 3. the family's guardian, found or made
  const guardianId = await findOrCreateGuardian(admin, args);
  if (guardianId) {
    const g = await admin.from("guardians").select("stripe_customer_id").eq("id", guardianId).maybeSingle();
    if (g.data?.stripe_customer_id) return { custId: g.data.stripe_customer_id, ownerKind: "guardian", guardianId };
    const cust = await mint(stripeCall, secretKey, args, { guardian_id: guardianId });
    await admin.from("guardians").update({ stripe_customer_id: cust })
      .eq("id", guardianId).is("stripe_customer_id", null);
    return { custId: cust, ownerKind: "guardian", guardianId };
  }

  // nobody to own it: the customer still exists, reachable through the sale
  const cust = await mint(stripeCall, secretKey, args, {});
  return { custId: cust, ownerKind: "none", guardianId: null };
}

async function mint(
  stripeCall: (path: string, key: string, form: URLSearchParams) => Promise<any>,
  secretKey: string,
  args: { email: string; name: string; phone?: string },
  meta: Record<string, string>,
): Promise<string> {
  const cf = new URLSearchParams();
  cf.set("name", args.name);
  cf.set("email", args.email);
  if (args.phone) cf.set("phone", args.phone);
  for (const [k, v] of Object.entries(meta)) cf.set("metadata[" + k + "]", v);
  const cust = await stripeCall("customers", secretKey, cf);
  return cust.id as string;
}
