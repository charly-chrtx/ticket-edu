<div align="center">

# [Ticket-edu.com](https://ticket-edu.com)
### Le système de support collaboratif moderne, sécurisé et sans friction

![Version](https://img.shields.io/badge/Version-v0.9.1-blue?style=for-the-badge&logo=appveyor)
![Security](https://img.shields.io/badge/Security-E2EE-green?style=for-the-badge&logo=lock)
![License](https://img.shields.io/badge/License-MIT-orange?style=for-the-badge)

<br/>

![Interface principale](assets/misc/0.png)

</div>

---

## L’essence du projet

> **Ticket** est un outil de gestion du support technique pensé pour aller à l’essentiel.  
Pas d’inscription, pas de mots de passe à retenir, pas d’interface inutilement complexe.

Avec Ticket, vous créez en quelques secondes un **espace de support privé**, prêt à être partagé avec votre équipe.  
Chaque espace fonctionne avec un **code unique généré automatiquement**, garantissant un accès contrôlé sans sacrifier la simplicité.

- Aucun compte requis  
- Mise en place instantanée  
- Contrôle total pour le owner

---

## Une expérience utilisateur repensée

<div align="center">

### Un design au service de l’usage

</div>

L’interface n’est pas là pour impressionner, mais pour être efficace.  
Chaque choix visuel vise à rendre l’expérience fluide, claire et agréable, même sur de longues sessions.

| Pilier | Description |
| :--- | :--- |
| Direction artistique | Une identité visuelle cohérente et lisible |
| Animations | Des transitions discrètes qui guident l’utilisateur |
| Iconographie | Pictogrammes Material Design, simples et universels |
| Mode sombre | Natif et automatique pour un meilleur confort visuel |

<div align="center">
  <img src="assets/misc/4.png" alt="Mode sombre" width="80%">
  <p><i>Mode sombre natif, activé automatiquement</i></p>
</div>

Ticket s’adapte à tous les formats pour rester utilisable partout, sans compromis.

<div align="center">
<table>
  <tr>
    <td align="center" width="50%">
      <strong>Version ordinateur</strong>
    </td>
    <td align="center" width="50%">
      <strong>Version mobile</strong>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="assets/misc/5.png" alt="Interface desktop" width="100%">
    </td>
    <td align="center">
      <img src="assets/misc/6.png" alt="Interface mobile" width="100%">
    </td>
  </tr>
</table>
</div>

---

## Sécurité et respect de la vie privée

<div align="center">

### Des engagements clairs, sans compromis

</div>

La confidentialité n’est pas une option. Ticket applique des standards de sécurité élevés dès la conception.

| Engagement | Détails techniques |
| :--- | :--- |
| Rétention minimale | Suppression automatique après **3 heures** d’inactivité |
| Chiffrement E2EE | Clé unique par groupe, échanges chiffrés de bout en bout |
| Hébergement européen | Données stockées temporairement sur des serveurs UE |
| Aucune exploitation | Aucune revente, aucune analyse commerciale |

---

## Fonctionnalités

### Une logique simple, des détails bien pensés

- **Filtrage intelligent des tickets**  
- **Tickets colorés** pour une identification rapide et visuelle

### Modération assistée par IA (Ollama)

- **Filtrage automatique** basé sur *Granite3-Guardian 2B*  
- **Blacklist personnalisable** définie par le owner  
- **Fiabilité éprouvée** avec un taux de détection jusqu’à **91,03 %**

### Partage et administration

- **1,5 Go de stockage intégré** pour documents, images et logs
- **Intégration OAUTH avec Google Drive et Nextcloud**, pour recevoir les fichiers des dépots en toute sécurité  
- **Transferts sécurisés**, chiffrés pendant le transit  
- **Contrôle avancé** : limitation des tickets, bannissement, gestion des liens d’invitation

<br>
---

## Architecture technique

### Stack technologique

L’infrastructure repose sur des technologies éprouvées, simples à maintenir et performantes.

<br/>

<div align="center">

<table>
<tr>
<td align="center" width="96">
<img src="https://skillicons.dev/icons?i=debian" width="48" height="48" alt="Debian" />
<br/>Debian
</td>
<td align="center" width="96">
<img src="https://skillicons.dev/icons?i=nodejs" width="48" height="48" alt="Node.js" />
<br/>Node.js
</td>
<td align="center" width="96">
<img src="https://skillicons.dev/icons?i=html" width="48" height="48" alt="HTML5" />
<br/>HTML5
</td>
<td align="center" width="96">
<img src="https://skillicons.dev/icons?i=css" width="48" height="48" alt="CSS3" />
<br/>CSS3
</td>
<td align="center" width="96">
<img src="https://skillicons.dev/icons?i=js" width="48" height="48" alt="JavaScript" />
<br/>JavaScript
</td>
</tr>
</table>

<br/>

**Backend** • Debian • Node.js • Ollama (Granite3-Guardian) • WebSocket  
**Frontend** • HTML5 • CSS3 • Vanilla JS • Material Icons

</div>

<br/>

### Flux de données

<div align="center">
  <img src="assets/misc/15.png" alt="Flux de données" width="80%">
  <br>
</div>
