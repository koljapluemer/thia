# Sequencing lessons and agents that ask: prior art

Collected for the lessons of several views and the workshop agent's `ask` tool (2026-11-22), both built: see
[`web/app/doc/workshop/architecture.md`](../../web/app/doc/workshop/architecture.md).

- **Sequencing.** General rule systems fail with authors: SCORM 2004's Simple Sequencing was widely judged too complex,
  and its successor cmi5 kept one *moveOn* criterion per unit
  ([eFront](https://www.efrontlearning.com/blog/2013/04/why-scorm-2004-failed-what-that-means-for-tin-can.html),
  [EduTech Wiki](https://edutechwiki.unige.ch/en/Cmi5)); Moodle's access restrictions confuse teachers
  ([MDL-81786](https://tracker-old.moodle.org/browse/MDL-81786)). What works is small: Canvas Mastery Paths' three
  score ranges ([Canvas](https://community.canvaslms.com/t5/Canvas-Basics-Guide/What-is-MasteryPaths/ta-p/404483)),
  testing out at Khan Academy, Duolingo's one path (and the backlash at losing the choice of order,
  [Duolingo](https://blog.duolingo.com/new-duolingo-home-screen-design)). Branching tools daunt teachers
  ([UTS on H5P](https://educationexpress.uts.edu.au/blog/2020/07/01/focus-on-h5p-benefit-branching-scenarios/)), and
  working choice-based structures are mostly a main line with branches that rejoin it
  ([Ashwell](https://www.ifwiki.org/Standard_Patterns_in_Choice-Based_Games)).
- **Asking.** Ask when the answer is worth more than the interruption
  ([Horvitz 1999](https://www.erichorvitz.com/chi99horvitz.pdf)); recent agents score questions by expected
  information gain ([Deng et al.](https://proceedings.mlr.press/v306/deng26l.html),
  [value of information](https://arxiv.org/pdf/2601.06407)). Questions with 2–5 offered answers are the norm in
  conversational search and get far more replies than open ones
  ([MIMICS](https://arxiv.org/pdf/2006.00166.pdf), [AGENT-CQ](https://arxiv.org/pdf/2410.19692)); suggestions shown
  by default anchor ([BIT](https://www.bi.team/wp-content/uploads/2025/09/How-can-LLMs-reduce-our-own-biases-Analysis-Report.pdf)).
