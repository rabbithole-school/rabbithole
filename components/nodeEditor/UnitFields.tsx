"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Flex, Input, Textarea, VStack } from "@chakra-ui/react";
import { AddRow, Field, PillRow, Scroll, SectionHeader } from "./shared";
import { granuleTexts } from "@/convex/lib/granules";
import { SubjectInput } from "./SubjectInput";
import { NodeEditorSkeleton } from "./NodeEditorSkeleton";

export function UnitFields({ unitId }: { unitId: Id<"units"> }) {
  const unit = useQuery(api.units.get, { id: unitId });
  const subjectSuggestions = useQuery(api.units.subjects, {}) ?? [];
  const updateUnit = useMutation(api.units.update);

  const [subject, setSubject] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [bigIdea, setBigIdea] = useState("");
  const [newEQ, setNewEQ] = useState("");
  const [newEU, setNewEU] = useState("");

  useEffect(() => {
    // Reset local draft when remote unit value changes (e.g., switching units).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubject(unit?.subject ?? "");
  }, [unit?.subject]);
  useEffect(() => {
    // Reset local draft when remote unit value changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGradeLevel(unit?.gradeLevel ?? "");
  }, [unit?.gradeLevel]);
  useEffect(() => {
    // Reset local draft when remote unit value changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBigIdea(unit?.bigIdea ?? "");
  }, [unit?.bigIdea]);

  // useQuery returns undefined while loading, null when the unit
  // doesn't exist. Render the skeleton on undefined; null is handled
  // upstream (UnitDesigner shows its own "Unit not found" surface).
  if (unit === undefined) return <NodeEditorSkeleton kind="unit" />;
  if (unit === null) return null;
  // Granule fields store keyed objects (legacy rows may still be bare
  // strings) — the editor works in plain texts; units.update re-keys.
  const eqs = granuleTexts(unit.essentialQuestions);
  const eus = granuleTexts(unit.enduringUnderstandings);

  const blur =
    (key: "subject" | "gradeLevel" | "bigIdea", value: string) => () => {
      if (value !== ((unit[key] as string | undefined) ?? "")) {
        updateUnit({ id: unit._id, [key]: value || null });
      }
    };

  // Subject commits via SubjectInput, which can hand back an explicit
  // value when a suggestion is picked (local state hasn't flushed yet).
  const commitSubject = (override?: string) => {
    const next = override ?? subject;
    if (next !== (unit.subject ?? "")) {
      updateUnit({ id: unit._id, subject: next || null });
    }
  };

  const addEQ = async () => {
    const t = newEQ.trim();
    if (!t) return;
    await updateUnit({ id: unit._id, essentialQuestions: [...eqs, t] });
    setNewEQ("");
  };
  const removeEQ = async (idx: number) =>
    updateUnit({
      id: unit._id,
      essentialQuestions: eqs.filter((_, i) => i !== idx),
    });
  const addEU = async () => {
    const t = newEU.trim();
    if (!t) return;
    await updateUnit({ id: unit._id, enduringUnderstandings: [...eus, t] });
    setNewEU("");
  };
  const removeEU = async (idx: number) =>
    updateUnit({
      id: unit._id,
      enduringUnderstandings: eus.filter((_, i) => i !== idx),
    });

  return (
    <Scroll>
      <SectionHeader
        emoji={unit.emoji ?? "📘"}
        title={unit.title}
        subtitle="Unit"
        onTitleChange={(title) => updateUnit({ id: unit._id, title })}
        placeholder="Untitled unit"
      />
      <Flex gap={3}>
        <Field label="Subject" flex={1}>
          <SubjectInput
            value={subject}
            onChange={setSubject}
            onCommit={commitSubject}
            suggestions={subjectSuggestions}
            placeholder="e.g., Science"
          />
        </Field>
        <Field label="Grade" flex={1}>
          <Input
            size="sm"
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            onBlur={blur("gradeLevel", gradeLevel)}
            placeholder="e.g., 3rd-5th"
            fontFamily="heading"
            fontSize="sm"
            borderColor="gray.200"
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
        </Field>
      </Flex>
      <Field label="Big Idea">
        <Textarea
          value={bigIdea}
          onChange={(e) => setBigIdea(e.target.value)}
          onBlur={blur("bigIdea", bigIdea)}
          placeholder="The overarching concept or theme..."
          rows={2}
          fontSize="sm"
          fontFamily="body"
          borderColor="gray.200"
          _focus={{ borderColor: "violet.400", boxShadow: "none" }}
        />
      </Field>
      <Field label="Essential Questions">
        <VStack align="stretch" gap={1}>
          {eqs.map((q, idx) => (
            <PillRow key={q} text={q} onRemove={() => removeEQ(idx)} />
          ))}
          <AddRow
            value={newEQ}
            onChange={setNewEQ}
            onAdd={addEQ}
            placeholder="Add essential question..."
          />
        </VStack>
      </Field>
      <Field label="Enduring Understandings">
        <VStack align="stretch" gap={1}>
          {eus.map((u, idx) => (
            <PillRow key={u} text={u} onRemove={() => removeEU(idx)} />
          ))}
          <AddRow
            value={newEU}
            onChange={setNewEU}
            onAdd={addEU}
            placeholder="Add enduring understanding..."
          />
        </VStack>
      </Field>
    </Scroll>
  );
}
