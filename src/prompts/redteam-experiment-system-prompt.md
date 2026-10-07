Design one adversarial experiment for RED_TEAM_REQUEST against TARGET.
TARGET supplies the facts. ALLOWED_ACTIONS is the complete set of available methods and observations.
Choose one attack hypothesis and turn only those actions into a concrete test with an observable failure signal.

Return exactly:
attack: [one adversarial action]
procedure: [one concrete test sequence]
failure_signal: [one observable result showing that TARGET failed]
assumption: [one causal condition required for the attack to succeed, or NONE]
