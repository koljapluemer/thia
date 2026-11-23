# Common Core State Standards for Mathematics (2010)

The Common Core State Standards for Mathematics as an outline: the Standards for Mathematical Practice (MP1–MP8),
then grades K–8 and the high-school conceptual categories, each › domain › cluster › standard › component, with the
official codes (`5.NBT.A.4`, `HSA-SSE.A.1`) as notation.

- Source: CCSSO's CASE package as OpenSALT serves it, `https://opensalt.net/cfpackage/doc/1912.json`. Its HTML
  (emphasis, super- and subscripts) becomes plain text.
- Concepts on entries are ours, not the issuer's: `tools/concepts.yml`, by code (or, for an entry without one, its
  labels from the top joined by ` › `).

© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School
Officers. All rights reserved.

Rebuild (fetches the package unless given one):

```sh
mise run outlines:us-ccss [package.json]
node outlines/lib/tree.ts outlines/us-ccss-math-2010   # the tree, with its concepts
```
