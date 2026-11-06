# Trivia Party: notes for Claude

## Adding question packs

The owner writes question packs by asking Claude in chat (for example, "make a 30-question pack about 80s music") instead of using an API key at runtime. To create one:

1. Write `questions/<kebab-case-topic>.json` in this shape:
   ```json
   {
     "topic": "80s Music",
     "description": "One-line summary shown as a tooltip",
     "questions": [
       { "type": "multiple_choice", "question": "…?", "choices": ["correct", "wrong", "wrong", "wrong"], "correctIndex": 0 },
       { "type": "true_false", "question": "…", "choices": ["True", "False"], "correctIndex": 1 }
     ]
   }
   ```
   - `multiple_choice`: exactly 4 distinct choices, 1 correct. The server shuffles the choices, so putting the correct one at index 0 is fine.
   - `true_false`: choices exactly `["True", "False"]`.
   - Mix the types: roughly 70% multiple choice and 30% true/false, choosing whichever format suits each fact.
   - Only include facts you are confident are true. Avoid contested trivia, avoid questions whose answer changes over time, keep questions under 160 characters and choices under 60.
   - Write more questions than one game needs (25–40), so repeat games draw a different random sample.
   - `topic` is the name the host taps in the lobby, and it must be unique across packs.
2. Run `npm run validate-packs` and fix any problems it reports.
3. Commit and push. **Don't print the questions or answers in chat**: the host plays too and wants to be surprised.

## Dev

- `npm start` starts the server (port 3000). `npm test` runs the unit tests and validates the packs.
- Question sources, in order: a pack whose topic matches what the host typed (case-insensitive), then Claude (only when `ANTHROPIC_API_KEY` is set), then the general bank in `src/fallbackBank.js`.
