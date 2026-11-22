// The single copy lives in the MIT-licensed keypad package:
// packages/react-native-math-keypad/src/model/expressionTemplate.ts
// This re-export keeps the web, Convex and app-kit importers on their old
// path; the native vendor sync (native/scripts/sync-vendor.js) rewrites the
// path for the iPad app. Edit the package file.
export * from "../react-native-math-keypad/model/expressionTemplate";
