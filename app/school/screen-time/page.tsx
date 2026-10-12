"use client";

// School › Screen time — OUT OF SERVICE, deliberately.
//
// The table this route used to render read `api.deviceActivity.dailyUsage` and
// labelled its minutes "Measured". That label was false. The client heartbeated
// every 60s whenever `AppState` was "active", and on a supervised
// single-app-mode iPad "active" means FRONTMOST, not IN USE — so the nightly
// `ipad-fleet-release` MDM push, which relaunches Rabbithole with the screen off
// and nobody present, booked ~50-62 unattended minutes per device per release as
// measured foreground time. Roughly a third of all foreground minutes in the
// first fortnight of data were that artifact, and manual daytime releases put
// the same artifact inside school hours where time-of-day cannot separate it.
//
// The emitter is fixed (heartbeats now require a recent human interaction — see
// PRESENCE_IDLE_TIMEOUT_MS in native/src/lib/deviceActivityQueue.ts), but a
// native fix reaches the iPads only through a fleet release, not a merge. And
// because the telemetry, this page and the buggy emitter all shipped in the same
// commit, there is no clean earlier data to fall back to: EVERY stored row
// predates the fix.
//
// So this route stays out of service until the corrected build is confirmed
// across the whole fleet, at which point it should be restored with its earliest
// selectable day clamped to the first full institution-local day after that
// confirmation. The raw rows are preserved and nothing has been deleted — the
// honest move is to stop reporting them, not to silently repair them.
//
// The backing query is untouched and still gated by `scholarAdminQuery`.

import { ChartBar } from "@phosphor-icons/react";
import { Stack, Text } from "@chakra-ui/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Surface } from "@/components/ui/Surface";

export default function SchoolScreenTimePage() {
  return (
    <Surface>
      <Stack gap="4" maxW="2xl">
        <EmptyState
          size="lg"
          icon={<ChartBar />}
          title="Screen time is temporarily unavailable"
          hint="The device telemetry behind this page counted an iPad as in use whenever Rabbithole was frontmost — including the nightly automated app update, which wakes every iPad with nobody holding it. The minutes shown here were materially overstated, so the page is out of service rather than showing numbers we know to be wrong."
        />
        <Text textStyle="sm" color="fg.muted">
          Nothing has been deleted. The underlying records are intact. The app
          fix is ready and reaches the iPads with their next update; this page
          returns once every iPad is confirmed on the corrected build —
          reporting only the days measured after it.
        </Text>
      </Stack>
    </Surface>
  );
}
