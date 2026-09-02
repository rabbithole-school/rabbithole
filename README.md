# Rabbithole

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

The native Expo application lives in `native/`.
