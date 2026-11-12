# Consentement d'installation (winget), partagé par les deux invites du lanceur.
#
# Règle : DÉFAUT = REFUSER. Seule une réponse explicitement affirmative
# (`o`, `oui`, `y`, `yes`, insensible à la casse) autorise l'installation.
# Tout le reste — vide, espaces, « q », « non », « n », « 0 », réponse
# inattendue — refuse.
#
# POURQUOI la conversion en chaîne est OBLIGATOIRE : quand `Read-Host` ne lit
# rien (entrée fermée / aucune console), il renvoie **AutomationNull** — sans
# lever d'exception, donc le `catch` ne se déclenche pas. Une comparaison
# directe `$Answer -notmatch …` renverrait alors AutomationNull (valeur FAUSSE) :
# la branche de refus serait sautée et `winget install` s'exécuterait SANS
# consentement. `"$Answer"` ramène AutomationNull à `''`, qui refuse.
#
# Ce fichier est un module séparé pour être testable tel quel : les tests
# l'appellent réellement (fonction + `Read-Host` sur entrée fermée).
function Test-InstallConsent {
  param([object]$Answer)
  return ("$Answer" -match '^(o|oui|y|yes)$')
}
