---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 5
contexts: paper-set,library-corpus
activation: auto
match: /\b(literature review|lit review|review of (the )?literature)\b/i
match: /\b(conduct|write|create|generate|draft)\b.*\b(review|synthesis|survey)\b.*\b(on|about|regarding|of)\b/i
match: /\bconduct a literature review\b/i
match: /\b(review|synthesize|survey)\b.*\b(research|papers?|studies|findings?|literature)\b/i
---

<!--
  SKILL: Literature Review

  This skill activates when you ask for a literature review or synthesis
  (e.g., "conduct a literature review on X", "synthesize the research").

  You can customize:
  - Discovery phase: change how papers are found and selected
  - Review structure: modify sections (intro, themes, gaps, conclusion)
  - Citation format: adjust citation style
  - Depth vs breadth: change how many papers are deep-read vs skimmed

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Literature Review — intent and document structure

This skill declares the literature-review intent and preferred structure. The central ResearchPolicy owns corpus budgets, paging, screening depth, expansion checkpoints, and evidence requirements. Do not invent a separate paper cap or tool-call budget here.

### Scope and investigation

- Treat an explicitly selected Zotero corpus as the evidence pool, not as a sample.
- For a topic, collection, tag, or whole-library question, expand fuzzy wording into explicit subquestions, inclusion/exclusion criteria, synonyms, abbreviations, translations, and indirect descriptions.
- In Plan execution, inventory every frozen item, then use broad screening, recall expansion, targeted deep evidence, per-paper findings, and hierarchical theme synthesis. Persist these stages with `research_update`.
- Semantic retrieval and reformulation are recall probes. Never claim they literally scanned every paper.
- Missing abstracts, unindexed PDFs, OCR failures, and unreadable files remain unresolved unless metadata is enough to exclude them clearly.
- Preserve contradictions and negative evidence rather than forcing agreement.

### Reading

- Use `library_retrieve` for broad metadata, abstract, indexed lexical, and semantic evidence according to the resolved central policy. The Plan coordinator may page across multiple bounded calls.
- Use `paper_read({ mode:'overview'|'targeted', ... })` for included or unresolved candidates that require body evidence.
- Use `paper_read({ mode:'figures', ... })` only when a figure materially improves the synthesis. A generated figure is never source evidence.
- Bind persisted non-metadata research evidence to the verified read result that produced it.
- Never place a large corpus's raw content into one model context. Reduce paper findings into themes while retaining evidence references.

### Document structure

Prefer these sections unless the approved document contract says otherwise:

1. Introduction and review question
2. Scope and method
3. Thematic synthesis (organized by ideas or methods, not a paper-by-paper list)
4. Agreements, contradictions, and limitations
5. Research gaps and future directions
6. Conclusion
7. Scope and limitations

In Agent mode, the literature-review outcome is always a document. Finish with `submit_document` whether or not Plan mode is active:

- Write internal citation tokens such as `[[cite:C1]]` and provide item-key/evidence mappings.
- Never hand-format author-year citations or References. Zotero's centralized CSL service resolves both with the approved style and locale.
- Cite only frozen-corpus items backed by persisted evidence. Direct quotations also require strict quote verification.
- Do not ask afterward whether to save a note. The finalized document card owns Copy Markdown, Save Note, Export, and Expand actions.

Outside Plan mode, use the ordinary ResearchPolicy profile, copy the host-issued evidence IDs returned by read tools into every citation mapping, and state the actual coverage frontier and limitations. Never imply exhaustive review from sampled snippets.
