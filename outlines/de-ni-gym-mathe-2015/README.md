# Kerncurriculum Mathematik, Gymnasium 5–10 (Niedersachsen, 2015)

The Lernbereiche (chapter 3.3) of the Kerncurriculum für das Gymnasium, Schuljahrgänge 5–10, Mathematik, issued by the
Niedersächsisches Kultusministerium in 2015, as an outline: Doppelschuljahrgang › Lernbereich › Kern (bullets and
their sub-bullets) and Fakultative Erweiterungen.

- Source: [CuVo](https://cuvo.nibis.de/index.php?p=detail_view&docid=1779), the PDF at
  `https://cuvo.nibis.de/index.php?p=download&upload=63`.
- Only the short labels and the link are kept, never the PDF or its prose (the Intentionen): the portal says nothing
  on reusing the curriculum's text. The content areas each Lernbereich names and the notes on digital tools are left
  out.
- A few formulas are drawn in the PDF rather than written, so the builder corrects those labels to what it prints
  (`PRINTED` in `tools/build.ts`).
- Concepts on entries are ours, not the issuer's: `tools/concepts.yml`, by an entry's labels from its Lernbereich
  down (`Umgang mit natürlichen Zahlen › runden und schätzen`).

Rebuild (needs `pdftotext`, from poppler; fetches the PDF unless given one):

```sh
mise run outlines:de-ni [kc.pdf]
node outlines/lib/tree.ts outlines/de-ni-gym-mathe-2015   # the tree, with its concepts
```
