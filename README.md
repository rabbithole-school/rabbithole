# Rabbithole

Rabbithole is an AI tutor for kids that answers a question with a better
question, so the kid does the thinking. It was built for gifted learners and
their teachers, and it covers math practice as well as open-ended conversation
about any subject. Scholars use it in a web browser or in a native iPad app.

One part is MIT-licensed and published on its own, free to use and copy:
[react-native-math-keypad](https://github.com/rabbithole-school/react-native-math-keypad),
an on-screen math keypad for React Native and Expo where kids enter fractions,
mixed numbers, exponents and roots in answer boxes. Everything else here is
published for reading only (see "Status and license" below).

What's in this repository:

- **Socratic AI tutor.** A chat tutor running on Claude that holds back answers,
  gives the learner time to think, and follows their curiosity across subjects.
  Teachers write its prompts and can read any conversation or slip the tutor a
  private note mid-session.
- **Adaptive math practice.** Practice runs on a knowledge graph of math skills
  with prerequisite links and a spaced-repetition scheduler, so a learner works
  on what they are ready for and reviews skills before they fade.
- **Virtual math manipulatives.** Interactive number lines, place-value blocks,
  a rekenrek, fraction partitions, arrays, a balance scale, a coordinate plane,
  clocks, money, rulers, a protractor and more. The tutor can put one on screen
  in the middle of a conversation.
- **Teacher dashboard and curriculum tools.** A live view of every learner,
  units, lessons and assignments, and an AI observer that summarizes each
  session for the teacher.
- **iPad app.** A native app built with Expo and React Native, sharing a Convex
  backend with the Next.js web app.

The hosted version runs at [rabbithole.school](https://rabbithole.school) and
is invite-only.

## Status and license

Rabbithole is a source-available Socratic learning application designed to make
learners think more, not less. This repository is published for inspection from
the private production downstream without its Git history, production records,
credentials, or private operational artifacts. No permission to reuse or
redistribute the source is granted beyond the terms in `LICENSE`.

Rabbithole is looking for design partners. Open-source licensing is under
consideration, but this repository is not open source and the `LICENSE` grants
no rights to deploy or modify the code. If you are interested in deploying or
modifying Rabbithole, contact the maintainers through the issue tracker in
this repository to request permission and discuss collaboration.

## Deployment model

Subject to the current permission requirements, a user may join the hosted
`rabbithole.school` service as one institution, operate a self-hosted
one-institution deployment, operate a self-hosted multi-institution deployment,
or maintain a philosophy-, language-, district-, or nonprofit-specific
downstream serving one or many institutions. These deployment shapes do not
grant rights under the current `LICENSE`.

Rabbithole is a multi-institution engine. `institutions` and `memberships` are
the tenant boundary: authorization belongs on the server in every handler, and
role checks alone are insufficient. Public or unauthenticated handlers must
take explicit institution identity and fail closed for unknown or suspended
institutions. A primary-institution fallback is only appropriate inside an
explicitly first-party downstream adapter; contributors must never assume that
a downstream is single-tenant.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

To run it on this computer with a fictional school, a local backend, and no
accounts (macOS or Linux, Node 22, pnpm 10):

```bash
pnpm local:setup    # install, start a local Convex backend, seed, start the web app
pnpm local:status
pnpm local:stop
```

It prints `/dev-login` links for a teacher, a scholar, and a parent. It refuses
to run against a cloud Convex deployment. The web app and the local Convex
backend listen only on this computer. The backend is one pinned release of
Convex's local backend, set in `local/lib.sh`.

The native Expo application lives in `native/`.
