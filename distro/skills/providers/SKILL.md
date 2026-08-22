---
name: providers
description: Launch procedure for Distill child agents — keep the session's assigned harness and model, do not silently weaken the model, and record role / harness / model before work starts. Use before every worker launch and on any capacity error.
metadata:
  berdBundled: true
---

# Providers

Distill owns spawning. This skill is the check you run before work starts in an assigned session.

## 1. Use the assignment

The conductor session already has a harness and model. Child sessions inherit that target unless Distill selected another. Do not pick a weaker model because a stronger one is busy. If the assigned model is unavailable, stop and report it. Distill will retry or the operator will change the target.

## 2. Record the route

Before real work:

```text
ROUTE role=<role> harness=<id> model=<id or default> fallback_reason=<none | exact refusal>
```

Working silently on a different model is forbidden.

## 3. Delivery

- Pass the spec as content, never as "read the plan file."
- Several specialists on one task: separate roles, separate Distill sessions. Never copy a full history between them.

## 4. Capacity

If the harness returns rate limit, capacity, or auth failure: report the exact error and stop that session. Do not shop for a random model. Distill or the operator chooses the next target.
