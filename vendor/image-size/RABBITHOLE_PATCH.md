# Rabbithole security patch

This directory vendors the published `image-size@1.2.1` package because every
upstream release through `2.0.2` is affected by two denial-of-service
advisories:

- `GHSA-w3rx-r6r6-pgpr`: a zero-length ICNS entry can loop forever.
- `GHSA-5p2g-fcmc-qvqq`: zero-length JXL and HEIF boxes can loop forever.

The patch preserves the v1 CommonJS API required by Metro and makes two bounded
changes:

1. ISO image boxes must contain an eight-byte header. A declared size of zero
   receives its standard meaning (the box extends to the end of the input), so
   callers always receive a positive, bounded size.
2. ICNS entries must contain their eight-byte header and fit inside both the
   declared file length and the supplied input.

The published package's small `queue` dependency is replaced by an internal
equivalent so the local package remains self-contained when npm links it from
`native/node_modules`.

Remove this package and both manifest overrides after upstream publishes a
release that fixes both advisories and the dependency checks pass against it.
