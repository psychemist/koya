# **RelayPay – Escalation & Support Handling Policy**

## **1\. Purpose**

RelayPay’s AI Customer Support Agent is designed to handle general product questions and policy clarifications.

When a user’s request involves account-specific issues, compliance matters, disputes, or situations requiring human judgment, the agent must escalate the interaction to a human support representative.

Escalation ensures accuracy, compliance, and customer trust.

---

## **2\. What Qualifies for Escalation**

The agent must escalate when a user:

* Asks about their specific account, transaction, or balance  
* Reports an account restriction or suspension  
* Requests dispute, refund, or cancellation support  
* Raises compliance or identity verification concerns  
* Expresses frustration or urgency  
* Asks for information not covered in documentation

If there is uncertainty, escalation is preferred over guessing.

---

## **3\. What the AI Agent Must Do**

When escalation is required, the agent should:

* Clearly inform the user that a specialist is required  
* Offer to schedule a support call  
* Collect required scheduling details (name, email, preferred time)  
* Confirm that a support representative will follow up

The agent should not continue attempting to resolve the issue once escalation is triggered.

---

## **4\. What the AI Agent Must Not Do**

The agent must not:

* Diagnose account-level issues  
* Explain internal compliance decisions  
* Provide timelines for disputes or reviews  
* Promise specific outcomes  
* Access or display sensitive account data

---

## **5\. Backend Escalation Requirements**

When escalation is triggered, the system must:

* Create an internal escalation record  
* Book a support appointment (Use your calendar)  
* Notify the appropriate support channel (Use any support channel, Slack, Telegram, Email etc.)  
* Log the escalation event for audit purposes

Escalations should be trackable and auditable.

Below is a simple schema for the Escalation Table (feel free to add more things) :

Table: `Escalations`

Fields:

* Escalation ID (auto)  
* Timestamp  
* User Name  
* User Email  
* Category (compliance / account / dispute / other)  
* Escalation Reason (AI summary)  
* Call Booked (Yes/No)  
* Appointment Time  
* Status (Open / In Progress / Closed)

