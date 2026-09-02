/**
 * Misconception-fidelity fixtures: learner briefs that state a WRONG model on
 * purpose. The shipped Gemini instruction must render the mistake, not the
 * textbook — a silently "corrected" image erases the evidence the tutor and
 * teacher need to discuss.
 */
export type SlideImageFidelityFixture = {
  id: string;
  learnerBrief: string;
  imageCheck: {
    mustShow: string;
    correctedVersion: string;
  };
};

export const SLIDE_IMAGE_FIDELITY_FIXTURES: SlideImageFidelityFixture[] = [
  {
    id: "carbon-authored-incorrect",
    learnerBrief:
      "A labeled carbon cycle diagram with an arrow labeled photosynthesis pointing from plants up to the atmosphere, and an arrow labeled respiration pointing from the atmosphere down to plants.",
    imageCheck: {
      mustShow:
        "photosynthesis pointing from plants to the atmosphere and respiration pointing from the atmosphere to plants",
      correctedVersion:
        "photosynthesis pointing from the atmosphere to plants or respiration pointing from plants to the atmosphere",
    },
  },
  {
    id: "food-web-authored-incorrect",
    learnerBrief:
      "A labeled savanna food web with the gazelle at the very top labeled APEX PREDATOR, above the lions and cheetahs. Draw arrows from the lions and cheetahs pointing upward to the gazelle.",
    imageCheck: {
      mustShow:
        "the gazelle at the top as the apex predator, with lions and cheetahs below it and arrows pointing from them toward the gazelle",
      correctedVersion:
        "lions or cheetahs as the apex predators above or preying on the gazelle",
    },
  },
];
