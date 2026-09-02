/**
 * The opening declaration-and-invasion sequence used by the WWI quest stepper.
 * Dates follow the July Crisis chronology. Two separate events occurred on
 * 4 August, so they remain separate steps rather than being collapsed.
 */
import type { LngLat } from "../../types";

export interface Ww1DeclarationEvent {
  id: string;
  dateLabel: string;
  actor: string;
  target: string;
  description: string;
  actorCenter: LngLat;
}

export const ww1Declarations: Ww1DeclarationEvent[] = [
  {
    id: "1914-07-28-austria-hungary-serbia",
    dateLabel: "28 Jul 1914",
    actor: "Austria-Hungary",
    target: "Serbia",
    description: "Austria-Hungary declares war on Serbia.",
    actorCenter: [16.4, 47.2],
  },
  {
    id: "1914-08-01-germany-russia",
    dateLabel: "1 Aug 1914",
    actor: "German Empire",
    target: "Russian Empire",
    description: "Germany declares war on Russia.",
    actorCenter: [10.5, 51.2],
  },
  {
    id: "1914-08-03-germany-france",
    dateLabel: "3 Aug 1914",
    actor: "German Empire",
    target: "France",
    description: "Germany declares war on France.",
    actorCenter: [10.5, 51.2],
  },
  {
    id: "1914-08-04-germany-belgium",
    dateLabel: "4 Aug 1914",
    actor: "German Empire",
    target: "Belgium",
    description: "German forces invade neutral Belgium.",
    actorCenter: [10.5, 51.2],
  },
  {
    id: "1914-08-04-uk-germany",
    dateLabel: "4 Aug 1914",
    actor: "United Kingdom",
    target: "German Empire",
    description: "The United Kingdom declares war on Germany.",
    actorCenter: [-2.5, 54.5],
  },
  {
    id: "1914-08-06-austria-hungary-russia",
    dateLabel: "6 Aug 1914",
    actor: "Austria-Hungary",
    target: "Russian Empire",
    description: "Austria-Hungary declares war on Russia.",
    actorCenter: [16.4, 47.2],
  },
];
