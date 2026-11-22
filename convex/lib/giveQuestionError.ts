/** Thrown when a give is missing an answer the teacher must supply. The
 *  message is a question, worded for the teacher. Its own module so the
 *  class linker can throw it without importing giveWindow (which imports the
 *  linker). */
export class GiveQuestionError extends Error {}
