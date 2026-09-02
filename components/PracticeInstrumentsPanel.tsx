"use client";

/**
 * Practice instruments — the read-only calibration panel from the practice
 * plan of record (review/practice/practice-plan-of-record.html §9): "instrument,
 * not re-argue." Every number here is a proxy computed off EXISTING rows
 * (convex/practiceInstruments.ts) — there is no new event log yet, so a couple
 * of these are explicitly labeled proxies rather than exact rates. Platform-
 * admin only (see convex/practiceInstruments.ts `getInstruments`).
 */

import { useQuery } from "convex/react";
import { useState } from "react";
import { Box, Grid, HStack, Progress, Stack, Table, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/ui/Surface";
import { FieldSelect } from "@/components/ui/FieldSelect";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <Surface p={4}>
      <Text fontSize="xs" fontFamily="heading" color="charcoal.400" textTransform="uppercase" letterSpacing="wide">
        {label}
      </Text>
      <Text fontSize="2xl" fontFamily="heading" fontWeight="700" color="navy.500" mt={1}>
        {value}
      </Text>
      {hint && (
        <Text fontSize="xs" color="charcoal.400" mt={1}>
          {hint}
        </Text>
      )}
    </Surface>
  );
}

function SectionSurface({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Surface p={5}>
      <Stack gap={0} mb={4}>
        <Text fontFamily="heading" fontWeight="600" fontSize="md" color="navy.500">
          {title}
        </Text>
        {subtitle && (
          <Text fontSize="xs" color="charcoal.400">
            {subtitle}
          </Text>
        )}
      </Stack>
      {children}
    </Surface>
  );
}

function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function ms(n: number | undefined): string {
  if (n === undefined) return "—";
  return `${Math.round(n).toLocaleString()} ms`;
}

export function PracticeInstrumentsPanel() {
  const [domain, setDomain] = useState<string>("");

  // Unfiltered fetch just to populate the domain filter's option list.
  const all = useQuery(api.practiceInstruments.getInstruments, {});
  const data = useQuery(
    api.practiceInstruments.getInstruments,
    domain ? { domain } : {},
  );

  const domainOptions = all?.domainExhaustion.map((d) => d.domain) ?? [];

  return (
    <Stack gap={6}>
      <PageHeader
        title="Practice instruments"
        subtitle="Calibration counters for the practice engine — instrumentation, not a verdict. Some are honest proxies until a dedicated event log lands."
        rightSlot={
          <FieldSelect
            value={domain}
            onChange={setDomain}
            w="220px"
            fieldProps={{ "aria-label": "Filter by domain" }}
          >
            <option value="">All domains</option>
            {domainOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </FieldSelect>
        }
      />

      {!data ? (
        <Text color="charcoal.400">Loading…</Text>
      ) : (
        <>
          <SectionSurface
            title="Acceleration valve"
            subtitle="Rows the valve has ever fired (source: accelerated). “Lapsed” is a PROXY for a false fire — a true per-attempt fire rate needs a future valve-events log; this counts rows now due again."
          >
            <Grid templateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap={3}>
              <StatCard label="Fired" value={data.valve.fired} hint="accelerated-credit rows, ever" />
              <StatCard label="Still holding" value={data.valve.stillHolding} hint="not yet due" />
              <StatCard label="Lapsed (false-fire proxy)" value={data.valve.lapsed} hint="now due again" />
              <StatCard label="Lapse rate (proxy)" value={pct(data.valve.lapseRate * 100)} />
            </Grid>
          </SectionSurface>

          <SectionSurface
            title="Source mix"
            subtitle="Where fluent credit (repetition ≥ fluent threshold) came from, across the cohort."
          >
            <Grid templateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap={3}>
              <StatCard label="Practice" value={data.sourceMix.counts.practice ?? 0} />
              <StatCard label="Placement" value={data.sourceMix.counts.placement ?? 0} />
              <StatCard label="Accelerated" value={data.sourceMix.counts.accelerated ?? 0} />
              <StatCard label="Total fluent" value={data.sourceMix.total} />
            </Grid>
          </SectionSurface>

          <SectionSurface
            title="Latency baseline distribution"
            subtitle="Per-skill median first-key latency, across every scholar/skill reading."
          >
            {data.latency.count === 0 ? (
              <Text color="charcoal.400" fontSize="sm">
                No latency readings yet.
              </Text>
            ) : (
              <Grid templateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap={3}>
                <StatCard label="Min" value={ms(data.latency.min)} />
                <StatCard label="p25" value={ms(data.latency.p25)} />
                <StatCard label="Median" value={ms(data.latency.median)} />
                <StatCard label="p75" value={ms(data.latency.p75)} />
                <StatCard label="Max" value={ms(data.latency.max)} />
              </Grid>
            )}
          </SectionSurface>

          <SectionSurface
            title="Error-pattern base rates"
            subtitle="Classified wrong answers, last 14 days, grouped by buggy-algorithm pattern."
          >
            {data.errorPatterns.length === 0 ? (
              <Text color="charcoal.400" fontSize="sm">
                No classified errors in the last 14 days.
              </Text>
            ) : (
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader fontFamily="heading">Pattern</Table.ColumnHeader>
                    <Table.ColumnHeader fontFamily="heading" textAlign="end">Count</Table.ColumnHeader>
                    <Table.ColumnHeader fontFamily="heading" textAlign="end">Scholars affected</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.errorPatterns.map((row) => (
                    <Table.Row key={row.pattern}>
                      <Table.Cell fontFamily="body">{row.pattern}</Table.Cell>
                      <Table.Cell textAlign="end">{row.count}</Table.Cell>
                      <Table.Cell textAlign="end">{row.scholarCount}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </SectionSurface>

          <SectionSurface
            title="Domain exhaustion"
            subtitle="How close is the room to climbing all of a domain — a proxy: fluent-node instances vs. (total nodes × scholars who've touched the domain)."
          >
            {data.domainExhaustion.length === 0 ? (
              <Text color="charcoal.400" fontSize="sm">
                No domains yet.
              </Text>
            ) : (
              <Stack gap={3}>
                {data.domainExhaustion.map((row) => (
                  <Box key={row.domain}>
                    <HStack justify="space-between" mb={1}>
                      <Text fontFamily="heading" fontSize="sm" color="charcoal.700">
                        {row.domain}
                      </Text>
                      <Text fontSize="xs" color="charcoal.400">
                        {row.fluentNodeInstances} fluent · {row.totalNodes} nodes · {row.scholarCount} scholars ·{" "}
                        {pct(row.avgPercentComplete)}
                      </Text>
                    </HStack>
                    <Progress.Root value={row.avgPercentComplete} size="xs" colorPalette="violet">
                      <Progress.Track borderRadius="full">
                        <Progress.Range borderRadius="full" />
                      </Progress.Track>
                    </Progress.Root>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionSurface>
        </>
      )}
    </Stack>
  );
}
