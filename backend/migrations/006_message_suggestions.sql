-- Sugestiile de continuare generate după fiecare răspuns, ca să reapară
-- la redeschiderea conversației (nu doar în fluxul SSE).

ALTER TABLE messages ADD COLUMN suggestions JSONB NOT NULL DEFAULT '[]';
