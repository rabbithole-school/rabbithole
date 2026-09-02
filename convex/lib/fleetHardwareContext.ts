/**
 * fleetHardwareContext — the Slack aide's durable model-facing understanding of
 * the physical device the primary school's scholars actually use.
 *
 * WHY THIS EXISTS: the bot reasons competently about the codebase but had no
 * knowledge of the deployed MDM lockdown, so it confidently told a teacher a
 * "save the image from Chrome, then choose from library" workflow that is
 * IMPOSSIBLE on a scholar iPad (no Chrome, no Photos app, no Files app; the app
 * allowlist is exclusive and the device self-locks into a single-app kiosk).
 * This section gives the bot the smallest set of hardware facts that reliably
 * stops it inventing a consumer-iPad workaround, and tells it to say "that isn't
 * possible on our iPads" instead.
 *
 * FIRST-PARTY-ONLY COUPLING (multi-tenancy): every fact here describes the
 * PRIMARY institution's fleet specifically — its SimpleMDM allowlist, its ASAM
 * kiosk, its Safari/AirDrop/screenshot locks. Another school runs different (or
 * no) managed iPads, so telling its staff these constraints as if they were
 * their own would be wrong in the same way a name-substituted legal form is
 * wrong. The composing code in convex/slackBot.ts therefore gates this section
 * on the caller's institution being primary (server-side); do NOT genericize it
 * by substituting a school name — build a per-institution device profile when a
 * second school actually runs a managed fleet. See CLAUDE.md "First-party first,
 * then multi-tenant".
 *
 * SINGLE CANONICAL HOME: the exhaustive, load-bearing hardware facts live in
 * mdm/README.md and the deployed mdm/profiles/*.mobileconfig sources. This is a
 * deliberately short, high-signal digest that ships on every turn — keep it
 * tight and keep it in sync with those sources when the fleet policy changes.
 */

export const FLEET_HARDWARE_SYSTEM_PROMPT_SECTION = `
## Scholar iPad hardware (locked fleet)

Our scholars use the native Rabbithole iPad app on a heavily locked-down, MDM-managed school iPad — NOT an ordinary consumer iPad. Answer and design within these real constraints, and never invent a consumer-iPad workaround (source of truth: mdm/README.md).

- Each scholar iPad self-locks into Rabbithole as a single-app kiosk (Autonomous Single App Mode, surfaced to staff as "Rabbithole Lock"). The app allowlist is EXCLUSIVE: besides Rabbithole, the only apps a scholar can even open are LEGO Education SPIKE (robotics) and Settings. Every other app is installed-but-hidden and unlaunchable — there is NO Chrome, NO Safari or any web browser, NO Photos app, NO Files app, and NO App Store. (Rabbithole's OWN in-app photo picker still works — see below; it is the standalone Photos app that a scholar cannot open.)
- The camera IS enabled (used for capture inside the app) and AirPrint works (for printing slide speaker notes). Screenshots, AirDrop, and iCloud / document sync are turned OFF.
- Teachers are different: they use the Rabbithole WEB app in an ordinary browser on a regular computer. So a workflow that works for a teacher, or on your own machine, usually does NOT exist for a scholar on the iPad — keep the two straight.

When a request depends on something a scholar iPad simply cannot do — browsing the web, saving an image out of a web page, or moving files between apps — say plainly that it is not possible on our scholar iPads rather than inventing a workaround. Never describe an "open Chrome/Safari and Save to Photos" step: there is no browser to save from. Be precise about photos, because Rabbithole's own in-app picker DOES work — inside the app a scholar can take a photo, record a video, or choose an existing one from the device photo library. What is impossible is getting an OUTSIDE image into that library, so in practice it only ever holds what was captured on that iPad. Do not tell a teacher that choosing from the library is impossible; tell them the library has nothing in it but the scholar's own captures. Also remember that merging code does not change what is installed on a device — a native iPad change reaches scholars only through a separate app release.
`;

/**
 * The fleet-hardware section(s) to splice into the Slack aide's dynamic prompt
 * context for a given caller. First-party-only: the facts describe the PRIMARY
 * school's locked fleet, so a non-primary caller gets NOTHING (byte-identical to
 * the pre-feature prompt). Keeping the gate → prompt mapping in one tiny pure
 * function makes it directly unit-testable.
 */
export function fleetHardwareSections(isPrimaryInstitution: boolean): string[] {
  return isPrimaryInstitution ? [FLEET_HARDWARE_SYSTEM_PROMPT_SECTION] : [];
}
