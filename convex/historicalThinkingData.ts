/**
 * Baked UCLA/NCHS Historical Thinking Standards import seed.
 *
 * Source: National Center for History in the Schools (NCHS), UCLA,
 * "Historical Thinking Standards" public pages. The framework is cataloged by
 * the Achievement Standards Network (ASN/D2L), but direct ASN resource fetches
 * are not reliable in the seed path (403); this module preserves the existing
 * stable Rabbithole `UCLA-HT` document id and `UCLA-HT-*` row identities while
 * moving the source data behind the shared ASN adapter.
 *
 * Attribution: National Center for History in the Schools, UCLA Public History
 * Initiative, Historical Thinking Standards:
 * https://phi.history.ucla.edu/nchs/historical-thinking-standards/
 * https://phi.history.ucla.edu/nchs/historical-thinking-standards/overview/
 */

import type { AsnStandardEntry, AsnStandardsDataset } from "./lib/asnStandardsAdapter";

export const HISTORICAL_THINKING_ASN_DOCUMENT_ID = "UCLA-HT";
export const HISTORICAL_THINKING_SOURCE_TITLE = "UCLA Historical Thinking Standards";
export const HISTORICAL_THINKING_SOURCE_JURISDICTION = "UCLA/NCHS";
export const HISTORICAL_THINKING_SUBJECT = "Historical Thinking";

export const HISTORICAL_THINKING_GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"];

export const HISTORICAL_THINKING_STANDARDS: AsnStandardEntry[] = [
  { id: "UCLA-HT-1", notation: "HT.1", description: "Chronological Thinking", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: false, label: "Domain" },
  { id: "UCLA-HT-1-A", notation: "HT.1.A", description: "Distinguish between past, present, and future time", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-B", notation: "HT.1.B", description: "Identify the temporal structure of a historical narrative or story", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-C", notation: "HT.1.C", description: "Establish temporal order in constructing historical narratives of their own", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-D", notation: "HT.1.D", description: "Measure and calculate calendar time", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-E", notation: "HT.1.E", description: "Interpret data presented in time lines and create time lines", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-F", notation: "HT.1.F", description: "Reconstruct patterns of historical succession and duration; explain historical continuity and change", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },
  { id: "UCLA-HT-1-G", notation: "HT.1.G", description: "Compare alternative models for periodization", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-1", label: "Standard" },

  { id: "UCLA-HT-2", notation: "HT.2", description: "Historical Comprehension", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: false, label: "Domain" },
  { id: "UCLA-HT-2-A", notation: "HT.2.A", description: "Identify the author or source of the historical document or narrative and assess its credibility", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-B", notation: "HT.2.B", description: "Reconstruct the literal meaning of a historical passage", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-C", notation: "HT.2.C", description: "Identify the central question(s) the historical narrative addresses", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-D", notation: "HT.2.D", description: "Differentiate between historical facts and historical interpretations", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-E", notation: "HT.2.E", description: "Read historical narratives imaginatively", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-F", notation: "HT.2.F", description: "Appreciate historical perspectives", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-G", notation: "HT.2.G", description: "Draw upon data in historical maps", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-H", notation: "HT.2.H", description: "Utilize visual, mathematical, and quantitative data", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },
  { id: "UCLA-HT-2-I", notation: "HT.2.I", description: "Draw upon visual sources including photographs, paintings, cartoons, and architecture", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-2", label: "Standard" },

  { id: "UCLA-HT-3", notation: "HT.3", description: "Historical Analysis and Interpretation", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: false, label: "Domain" },
  { id: "UCLA-HT-3-A", notation: "HT.3.A", description: "Compare and contrast differing sets of ideas, values, personalities, behaviors, and institutions", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-B", notation: "HT.3.B", description: "Consider multiple perspectives of various peoples by demonstrating their differing motives, beliefs, interests, hopes, and fears", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-C", notation: "HT.3.C", description: "Analyze cause-and-effect relationships and multiple causation, including the importance of the individual, the influence of ideas, and the role of chance", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-D", notation: "HT.3.D", description: "Draw comparisons across eras and regions in order to define enduring issues", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-E", notation: "HT.3.E", description: "Distinguish between unsupported expressions of opinion and informed hypotheses grounded in historical evidence", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-F", notation: "HT.3.F", description: "Compare competing historical narratives", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-G", notation: "HT.3.G", description: "Challenge arguments of historical inevitability", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-H", notation: "HT.3.H", description: "Hold interpretations of history as tentative, subject to change as new information is uncovered", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-I", notation: "HT.3.I", description: "Evaluate major debates among historians", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },
  { id: "UCLA-HT-3-J", notation: "HT.3.J", description: "Hypothesize the influence of the past", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-3", label: "Standard" },

  { id: "UCLA-HT-4", notation: "HT.4", description: "Historical Research Capabilities", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: false, label: "Domain" },
  { id: "UCLA-HT-4-A", notation: "HT.4.A", description: "Formulate historical questions", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },
  { id: "UCLA-HT-4-B", notation: "HT.4.B", description: "Obtain historical data from a variety of sources", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },
  { id: "UCLA-HT-4-C", notation: "HT.4.C", description: "Interrogate historical data", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },
  { id: "UCLA-HT-4-D", notation: "HT.4.D", description: "Identify the gaps in the available records and marshal contextual knowledge and perspectives of the time and place", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },
  { id: "UCLA-HT-4-E", notation: "HT.4.E", description: "Employ quantitative analysis", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },
  { id: "UCLA-HT-4-F", notation: "HT.4.F", description: "Support interpretations with historical evidence", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-4", label: "Standard" },

  { id: "UCLA-HT-5", notation: "HT.5", description: "Historical Issues-Analysis and Decision-Making", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: false, label: "Domain" },
  { id: "UCLA-HT-5-A", notation: "HT.5.A", description: "Identify issues and problems in the past", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
  { id: "UCLA-HT-5-B", notation: "HT.5.B", description: "Marshal evidence of antecedent circumstances", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
  { id: "UCLA-HT-5-C", notation: "HT.5.C", description: "Identify relevant historical antecedents", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
  { id: "UCLA-HT-5-D", notation: "HT.5.D", description: "Evaluate alternative courses of action", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
  { id: "UCLA-HT-5-E", notation: "HT.5.E", description: "Formulate a position or course of action on an issue", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
  { id: "UCLA-HT-5-F", notation: "HT.5.F", description: "Evaluate the implementation of a decision", gradeLevels: HISTORICAL_THINKING_GRADES, isLeaf: true, parent: "UCLA-HT-5", label: "Standard" },
];

export const HISTORICAL_THINKING_DATASET: AsnStandardsDataset = {
  asnDocumentId: HISTORICAL_THINKING_ASN_DOCUMENT_ID,
  title: HISTORICAL_THINKING_SOURCE_TITLE,
  subject: HISTORICAL_THINKING_SUBJECT,
  jurisdiction: HISTORICAL_THINKING_SOURCE_JURISDICTION,
  entries: HISTORICAL_THINKING_STANDARDS,
};
