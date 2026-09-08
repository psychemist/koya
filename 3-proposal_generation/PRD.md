# Week 3 PRD: AI Proposal / Document Application

## Business Context

After discovery calls, the sales team writes custom client proposals by pulling from notes, old proposals, saved templates, and internal context. The process takes too long, and the quality depends heavily on who writes the proposal.

The team needs a better way to turn sales requirements into a polished proposal while keeping a human in control before anything goes to the client.

## Project Objective

Build an AI-powered proposal application that takes client and project inputs, uses Claude to generate proposal content, lets a salesperson review and revise the output, creates a final proposal document, handles internal approval before client delivery, and logs the proposal in a central place.

You may use the existing [proposal intake fields](assets/intake-form-fields.md), [proposal template](assets/proposal-template.md), and [client email template](assets/client-email-template.md) as references for your build.

You will be required to build a **small web application** and use **Claude API** for proposal generation. You are free to choose the frontend, backend, database, approval flow, document-generation method, and delivery tools that best fit your build.

## Testing

To make sure your application works reliably, test it against the following scenarios before submission:

1. **Normal Proposal Generation**: A complete proposal input should generate a clear, structured proposal.

2. **Missing Information**: If important details are missing, the application should ask for clarification, mark the gap, or avoid making unsupported assumptions.

3. **Supporting Material**: If supporting material is provided, the proposal should use it in a relevant way.

4. **Section Regeneration**: The salesperson should be able to revise or regenerate one section without losing the rest of the proposal.

5. **Human Approval**: The proposal should not be sent to the client before internal approval.

6. **Final Delivery and Logging**: The approved proposal should be exported or sent, and the proposal record should be logged.

7. **Failure Handling**: If document creation, approval, email delivery, or logging fails, the system should make the failure clear enough to debug.

Submit the completed testing evidence table from the project page with your project.

## Deliverables

Submit the following:

1. **Application link**

   A working link to your proposal application.

2. **Generated proposal sample**

   A sample proposal created by your application.

3. **Testing evidence**

   Completed testing evidence table.

4. **Video walkthrough**

   A short Loom video showing the application in action.

5. **Reflection sheet**

   Answer the questions in your reflection sheet for this project.

6. **One-page documentation**

   Submit one page of documentation for your system.
