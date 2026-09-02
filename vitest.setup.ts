// Unit tests are hermetic: no real model call may ever leave the process.
// The AI clients fail soft when their key is absent (geminiGenerateImage
// returns null without GEMINI_API_KEY; the aide pipeline records an error
// without ANTHROPIC_API_KEY), so suites that reach them through scheduled
// functions stay green only while these keys happen to be missing. Strip them
// up front so a shell that exports real keys (eval tooling does) cannot
// silently turn a vitest run into billed Gemini/Anthropic/OpenAI traffic.
//
// A test that needs a key stubs a fake one itself and mocks the transport —
// vi.stubEnv("GEMINI_API_KEY", "test-key") + a fetch stub (flairArt.test.ts),
// or vi.mock("../lib/gemini") (tutorSessionTools.test.ts,
// calculatorLicense.test.ts). Pinned by convex/__tests__/hermeticEnv.test.ts.
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
