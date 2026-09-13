# Naming Registry

This registry contains only confirmed canonical concepts.
Do not add synonyms for the same idea.

## Confirmed concepts

### Project
A tenant-scoped unit of work or product context inside KIP.

### Actor
An identity that initiates, requests, or receives actions in the system.

### Run
A traceable unit of work performed by KIP.

### Capability
A platform or skill-level ability that can be invoked.

### Skill
A specialized intelligence module built on top of Core.

### Resource
A concrete item, asset, or object managed by the platform.

### Event
A meaningful occurrence that the platform records or reacts to.

### Project Membership
The canonical link between a trusted Actor and a Project, carrying a constrained role (`owner | member | service`).
- **It is not** an identity profile.
- **It is not** a permissions engine.
- **It is not** an invitation or team-flow record.
