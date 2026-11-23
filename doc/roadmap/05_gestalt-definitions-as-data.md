# Gestalt definitions as data: what's left

From a discussion on 2026-11-15. Built: model packages beside plugins, namespaced names for new gestalts, and the
structural/presentational split with published definitions checked (2026-11-17,
[[../architecture/plugins-and-views#Models|Models]], [[../reference/data-format#Published definitions don't change|Data format]]);
and the core of definitions as ymls (`gestalt@1`, load order, reindexing, refusing redefinitions, limits, definitions
not merging; 2026-11-20, [[../reference/data-format#Definitions as ymls|Data format]]), which workshop drafts use.

What decides how far the rest goes: will gestalts be defined outside this repo, by vibecoded views, third-party or
learners' decks, without a release for each?

## Not built

- **Copying definitions into the user's folder** on the first write of a gestalt, so the folder describes itself and
  opens in an app that lacks the view (another distribution, an older version). They're small and never collected.
- **Migrating the model packages' gestalts into ymls.** Backwards compatible: an older app sees `gestalt@1` ymls as
  unknown, and those sync byte for byte.
- **Draft vs. published in the data.** A definition changes while it's being made, and mustn't once it has gone out in
  a deck or a sync. Some marker for that (a draft version, a draft namespace that never syncs, or published once in a
  deck), and the editor warns when tightening a draft makes ymls invalid. The teacher app checks it at publishing for
  now.
- **Copies agreeing by hash** (`GestaltDef::structure_hash`): structural parts never change under one `name@version`;
  presentational ones (descriptions, widget and `format` hints, labels of an `enum`) may and merge like any yml.

## Collisions between authors, only once there are outside ones

A namespace needs an owner. A deck shipping its own `geography/map-exercise@1` with another structure would, under
the hard-error rule, make everyone's exercises of the real one unqueryable. First-seen-wins decides differently per
device; priorities by source are a half-made authority; a hash named in every yml has no collisions but every yml
carries it and "the same type" becomes interpretation. The clean answer is a namespace per source (a deck's or an
author's id), checked against where a definition came from. For the teacher app, server-assigned namespaces and
promotion settle it ([[02_teacher-app|Teacher app]]); a general rule is designed last.
