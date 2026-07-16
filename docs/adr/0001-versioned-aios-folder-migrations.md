---
status: accepted
---

# Separate versioned folder migrations from setup

Existing AIOS folders evolve through a preview-first, versioned migration module rather than by rerunning first-time setup or granting broad overwrite permission. The folder's schema version—not the npm package version—selects ordered migrations; user memory stays outside the write surface, and only proven managed scaffold may change through an approved, receipted plan. This keeps updates useful for existing users without making a product release an implicit rewrite of their accumulated knowledge.
