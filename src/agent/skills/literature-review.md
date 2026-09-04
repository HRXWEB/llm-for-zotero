---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 6
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

This skill declares the literature-review intent and preferred structure.
The ordinary workflow is **read → understand → connect → write**.
The central ResearchPolicy owns capacity measurement, recovery, and evidence requirements.
Do not invent a paper cap or tool-call budget here.

### Scope and investigation

- Treat an explicitly selected Zotero corpus as the evidence pool, not as a sample.
- For an ordinary review, expand the user's question into explicit subquestions without turning them into eligibility criteria.
- Default to `reviewMode:'narrative'` and `readingStrategy:'adaptive'`.
- Do not choose a fixed number of papers to deep-read.
  Read every accessible paper in the frozen scope to the depth permitted by the measured model context, and report the actual per-paper coverage.
- Only use formal inclusion/exclusion screening when the user explicitly requests a systematic-review method, PRISMA-style selection, reproducible eligibility decisions, or an equivalent protocol.
- Use `reviewMode:'scoping'` when the goal is to map the breadth, concepts, methods, and gaps in a field rather than construct a focused explanatory argument.
- Missing abstracts, unindexed PDFs, OCR failures, and unreadable files remain unresolved unless metadata is enough to exclude them clearly.
- Preserve contradictions and negative evidence rather than forcing agreement.

### Reading

- After Plan approval, call `research_update({operation:'inventory_scope'})` once and use its exact reading manifest.
- For an adaptive narrative review, read one capacity-sized group with `paper_read({mode:'overview', targets:[...]})`, then immediately persist a rich understanding of that group with `research_update({operation:'record_papers', ...})` before reading more.
  The group size must follow the actual input and output capacity and the semantic relationships among the papers, never a fixed paper-count threshold.
- Never accumulate multiple unrecorded reading groups in the model transcript.
  After each durable reduction, the host checkpoints away the raw PDF text and supplies the exact remaining reading manifest for the next group.
- When a checkpoint supplies the remaining manifest, do not call inventory_scope again.
  Treat that manifest as authoritative and call `paper_read` for the next group directly.
- When the checkpoint says all papers are durable, do not call inventory_scope again.
  Continue directly with `list_findings`, cross-paper synthesis, and theme persistence.
- Build one durable paper understanding for every item: main message, research question, method and evidence, findings, proposed mechanisms, limitations, relevance, and relationships to other papers.
- Assign one or more descriptive roles such as central evidence, supporting evidence, contradictory evidence, theoretical foundation, methodological contribution, historical context, or tangential context.
- Use `paper_read({mode:'targeted', ...})` only to resolve an important uncertainty, check a decisive claim, or obtain a precise location after the broad reading pass.
- Use `paper_read({ mode:'figures', ... })` only when a figure materially improves the synthesis. A generated figure is never source evidence.
- Persist compact paper understandings and cross-paper relationship themes with `research_update`; the host binds internal evidence and finding identifiers.
- If the complete source text cannot fit, preserve coverage by allocating less text per paper or by using capacity-sized semantic groups, then synthesize across the durable understandings.

### Evidence-based quality checks

- Apply SANRA-style narrative-review checks: explain importance and aims, describe the reviewed scope, support key claims with references, reason from the strength and type of evidence, and present relevant outcome data accurately.
- For scoping reviews, map the breadth, concepts, evidence types, and gaps in line with JBI's purpose for scoping evidence synthesis.
- Keep PRISMA-style eligibility screening and exclusion accounting exclusive to systematic-review requests.

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
