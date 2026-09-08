"use client";

/**
 * Print, via the browser's own dialogue.
 *
 * This is the third path to a PDF, alongside the generated one and the DOCX,
 * and it costs nothing to provide: the print stylesheet in globals.css already
 * strips the chrome, forces a white ground and avoids breaking a heading away
 * from its text. A client who hits Cmd-P gets a clean document either way —
 * this button just makes it discoverable.
 */
export function PrintButton() {
  return (
    <button type="button" className="btn btn-sm" onClick={() => window.print()}>
      Print
    </button>
  );
}
