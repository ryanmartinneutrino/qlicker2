import { describe, expect, it } from 'vitest';
import {
  exportQuestionsToLatex,
  parseLatexQuestionSet,
  sanitizeLatexFigureMarkup,
} from '../../src/services/questionLatex.js';

const SAMPLE_LATEX = String.raw`
\documentclass[12pt, oneside, addpoints]{exam}
\begin{document}
\begin{questions}
\section*{Algebra}
\question[7] Solve the system.
\begin{align}
2x + y &= 5 \\
x - y &= 1
\end{align}
\begin{choices}
\choice $x=1, y=3$
\CorrectChoice $x=2, y=1$
\end{choices}
\begin{solution}
Subtract the second equation from the first.
\end{solution}

\question[4] What does the ignored figure show?
\includegraphics[width=0.5\textwidth]{figures/example.png}
\begin{solution}
A placeholder figure.
\end{solution}
\end{questions}
\end{document}
`;

describe('questionLatex service', () => {
  it('removes figure wrappers and normalizes simple figure references', () => {
    const sanitized = sanitizeLatexFigureMarkup(String.raw`
Figure \ref{fig:energy-1} shows the setup.
\begin{center}
__QUESTION_MANAGER_FIGURE_0__
\captionof{figure}{\label{fig:energy-1} Energy diagram for the setup.}
\end{center}
`);

    expect(sanitized).toContain('Figure 1 shows the setup.');
    expect(sanitized).toContain('__QUESTION_MANAGER_FIGURE_0__');
    expect(sanitized).toContain('Energy diagram for the setup.');
    expect(sanitized).not.toContain('\\begin{center}');
    expect(sanitized).not.toContain('\\captionof');
    expect(sanitized).not.toContain('\\label{');
    expect(sanitized).not.toContain('\\ref{');
  });

  it('imports exam-class LaTeX into question-manager question payloads and preserves export structure', async () => {
    const { questions, warnings } = await parseLatexQuestionSet(SAMPLE_LATEX, {
      app: {},
      userId: 'prof-1',
      importTags: ['Midterm'],
      importFilename: 'mcquestions.tex',
      importIgnoredPoints: true,
    });

    expect(questions).toHaveLength(2);
    expect(questions[0].questionManager.importFormat).toBe('latex');
    expect(questions[0].questionManager.importFilename).toBe('mcquestions.tex');
    expect(questions[0].questionManager.importIgnoredPoints).toBe(true);
    expect(questions[0].sessionOptions.points).toBe(1);
    expect(questions[0].content).toContain('$$');
    expect(questions[0].content).toContain('\\begin{align}');
    expect(questions[0].tags.map((tag) => tag.value)).toEqual(expect.arrayContaining(['Imported', 'LaTeX', 'Midterm', 'Algebra']));
    expect(warnings).toEqual(expect.arrayContaining(['Question 2: attached figures were ignored during LaTeX import.']));

    const exported = exportQuestionsToLatex(questions, { includePoints: false });
    expect(exported).toContain('\\documentclass[12pt, oneside, addpoints]{exam}');
    expect(exported).toContain('\\begin{questions}');
    expect(exported).toContain('\\section*{Multiple Choice}');
    expect(exported).toContain('\\section*{Short Answer}');
    expect(exported).toContain('\\begin{solution}');
  });

  it('cleans up centered attachment-figure wrappers and refs during import', async () => {
    const latexWithCenteredFigure = String.raw`
\documentclass[12pt, oneside, addpoints]{exam}
\begin{document}
\begin{questions}
\question[3] Figure \ref{fig:attachment-demo} shows the setup.
\begin{center}
\includegraphics[width=0.5\textwidth]{figures/example.png}
\captionof{figure}{\label{fig:attachment-demo} Experimental setup}
\end{center}
\begin{solution}
Use Figure \ref{fig:attachment-demo}.
\end{solution}
\end{questions}
\end{document}
`;

    const { questions, warnings } = await parseLatexQuestionSet(latexWithCenteredFigure, {
      app: {},
      userId: 'prof-1',
    });

    expect(questions).toHaveLength(1);
    expect(questions[0].plainText).toContain('Figure 1 shows the setup.');
    expect(questions[0].plainText).toContain('Experimental setup');
    expect(questions[0].plainText).not.toContain('\\begin{center}');
    expect(questions[0].plainText).not.toContain('\\ref{');
    expect(questions[0].solution_plainText).toBe('Use Figure 1.');
    expect(warnings).toEqual(expect.arrayContaining([
      'Question 1: attached figures were ignored during LaTeX import.',
    ]));
  });
});
