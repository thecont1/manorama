# manorama — fresh-start designer brief

This document is for a designer who should approach manorama as a product to be designed almost from first principles. It does **not** assume the current layouts are good, fixed, or even structurally correct. Its purpose is to explain what the app is, what jobs it is trying to do, what states and flows it must support, and what tensions are currently visible so that a cleaner design system and product structure can be proposed.

## What manorama is

manorama is a photography-first gallery viewer and gallery-publishing app.

At its best, the product promise appears to be this:

- Open a public photo gallery from a cloud source.
- Present the photographs with respect, at generous size, on a quiet canvas.
- Preserve the feeling that the images matter more than the interface.
- Allow limited management of galleries from a mobile device.
- Support device-local behavior such as encrypted offline storage and a local photo picker.

The underlying idea is not social media, not a conventional photo grid, and not a file browser. It is closer to a calm presentation environment for photographs, with some lightweight publishing and management tools wrapped around it.

## The core product jobs

A good redesign should begin by recognizing that the app is currently trying to do several distinct jobs.

### 1. Let someone sign in and have an account

The app supports account identity and appears to allow sign-in through at least:
- Apple
- Dropbox
- Google Drive

This means the app needs some kind of account entry, identity confirmation, and account-specific landing state.

### 2. Let someone add a gallery from a public cloud link

A user can add a gallery by pasting a public folder or album link from a cloud service. Based on the observed copy, this likely includes providers such as Dropbox, Google Drive, iCloud, and MEGA.

This means the app needs:
- an input mechanism for a public URL,
- validation / loading feedback,
- a success path that creates or loads the gallery,
- and failure states when a link is invalid or unreadable.

### 3. Let someone browse their galleries

The account area needs to show existing galleries and basic metadata such as:
- gallery title,
- gallery URL,
- item count,
- optional caption,
- preview image,
- and some per-gallery actions.

This is not the same job as viewing a gallery. It is an administrative layer.

### 4. Let someone view a gallery as a photographic experience

This is the most important product job.

The app must let someone open a gallery and experience images in a deliberate, low-noise way. Existing evidence suggests multiple viewing modes, including:
- a continuous strip mode,
- a vertical scroll mode,
- and a one-at-a-time mode.

This part of the product should likely be treated as the design center of gravity.

### 5. Let someone control how a gallery behaves on their device

The app has device-specific behavior that is not just visual. It includes concepts such as:
- downloading gallery images to an encrypted vault,
- choosing not to download a gallery,
- retaining photos on the device,
- and showing locally available photos in a picker.

These are important features, but they are secondary to the act of viewing photographs.

### 6. Let someone perform management actions on a gallery

The screenshots imply several management actions, including things like:
- reorder images,
- edit or add a caption,
- duplicate or copy,
- open or launch,
- refresh or regenerate,
- and delete.

These are power or maintenance tasks. They should not dominate the experience.

### 7. Let someone understand subscription / plan limits

The app appears to have a free-user tier and subscription upsell. It surfaces ideas such as:
- number of galleries used,
- a gallery limit,
- subscription options,
- and possibly sponsored/promotional content.

This is business logic, but it is not the core reason a user comes to the app.

## The user model suggested by the screenshots

The screenshots suggest at least two user mindsets, and the redesign should probably respect the difference.

### The viewer mindset

This person wants to look at photographs. They care about:
- image size,
- low distraction,
- easy movement through the gallery,
- predictable gestures,
- and minimal interruptions.

For this user, the app should feel almost invisible.

### The owner / curator mindset

This person is managing a gallery. They care about:
- creating or importing a gallery,
- arranging image order,
- setting captions,
- sharing a gallery link,
- controlling storage behavior,
- and understanding account limits.

For this user, the app needs clear tools, but still with restraint.

These are not the same mode of use. One of the likely redesign opportunities is to separate them more cleanly.

## Product surfaces currently implied

A fresh redesign does not need to preserve these as-is, but it should account for their functions.

### A. Sign-in / welcome surface

Observed functions:
- establish brand presence,
- explain the product in one sentence or less,
- offer sign-in methods,
- possibly provide legal/footer links.

Design implication:
- This surface should answer: what is this, and what do I do first?
- It should not carry the burden of explaining every product feature.

### B. Account home / gallery dashboard

Observed functions:
- identify the user or account path,
- show usage / plan state,
- let the user add a gallery,
- list existing galleries,
- expose gallery-level actions,
- provide entry to broader navigation.

Design implication:
- This is an operational screen, not a photography screen.
- It should privilege scanability and task clarity over atmosphere.

### C. Gallery opening / transition surface

Observed functions:
- acknowledge the selected gallery,
- possibly create a pause before the immersive viewing experience.

Design implication:
- This may or may not deserve to exist.
- If it exists, it should justify itself by improving orientation or emotional pacing.
- If it does not clearly help, it can disappear.

### D. Gallery viewer

Observed functions:
- present photographs at large size,
- minimize chrome,
- allow navigation,
- possibly overlay a very small amount of control UI.

Design implication:
- This is the product’s most defensible and differentiated experience.
- Any redesign should probably begin here and let the rest of the app inherit its discipline.

### E. Display / viewing controls surface

Observed functions:
- switch viewing mode,
- change background treatment,
- show navigation arrows,
- enter fullscreen,
- control device-specific download behavior,
- show download progress,
- and possibly provide a way back to galleries.

Design implication:
- This is currently a cluster of settings with different meanings.
- A redesign should decide whether these belong in one place or several.

### F. Info / subscription / device setup surface

Observed functions:
- explain what happens when a gallery opens,
- set the default gallery-loading behavior,
- expose subscription options,
- configure photo picker readiness,
- explain encrypted local behavior.

Design implication:
- This is a mixed-purpose surface and should probably be decomposed.
- The user likely does not need all of this at once.

### G. Reorder surface

Observed functions:
- allow image sequence editing,
- communicate what has moved,
- save or discard the new order.

Design implication:
- This is a task screen.
- It should be fast, explicit, and confidence-building rather than atmospheric.

## Essential entities the design must account for

The following are not layout details; they are core pieces of product meaning.

### Gallery

A gallery appears to have at least:
- a title or slug,
- an owner/account namespace,
- a public URL,
- a count of images,
- an optional caption,
- one or more preview images,
- an order of images,
- viewer settings,
- and device-local state.

### Photograph

A photograph likely has:
- image content,
- sequence position,
- orientation (portrait / landscape),
- possibly metadata or provenance,
- and maybe a caption or contextual information.

### User account

A user account appears to have:
- a sign-in identity,
- an owner namespace,
- plan information,
- a set of galleries,
- and local device-specific preferences or permissions.

### Device-local state

The app has a local behavior layer that matters a great deal:
- encrypted vault state,
- whether a gallery is downloaded,
- download progress,
- whether local photos are available to the picker,
- and whether viewing is streaming or device-backed.

## Functional requirements implied by the screenshots

A redesign should not assume all of these belong in the same flow, but they likely need homes.

### Authentication and onboarding
- Sign in with multiple providers.
- Explain the app very briefly.
- Handle users with no galleries yet.

### Gallery creation
- Paste public folder or album link.
- Trigger gallery creation or import.
- Show loading, failure, and success states.

### Gallery library
- Show all galleries belonging to the account.
- Provide at-a-glance metadata.
- Open a gallery.
- Expose secondary actions per gallery.

### Gallery viewing
- Enter a distraction-minimized viewing mode.
- Support multiple presentation modes.
- Handle portrait and landscape photographs gracefully.
- Allow exiting back to the gallery library.

### Gallery settings
- Configure presentation mode.
- Configure background/canvas treatment.
- Toggle additional viewing affordances.
- Manage device download behavior.

### Gallery maintenance
- Reorder photographs.
- Save or discard changes.
- Edit captions.
- Delete gallery.
- Possibly duplicate, refresh, or share.

### Subscription / plan visibility
- Show free-tier status and limits.
- Offer subscription upgrade path.
- Distinguish core product actions from monetization.

### Device-specific behavior
- Explain encrypted storage clearly.
- Allow users to keep or avoid local copies.
- Prepare on-device photos for use in the app.

## Product tensions the designer should know about

These are not instructions for visual style. They are tensions inherent in the product.

### 1. Viewer versus manager

The strongest part of the app concept is the image-viewing experience.
The noisiest part of the app concept is the gallery-management layer.
A redesign should prevent the management logic from overwhelming the viewing identity.

### 2. Atmosphere versus utility

The brand language is poetic and theatrical.
The actual tasks include forms, settings, quotas, toggles, and maintenance actions.
A new design needs a way for those two modes to coexist without one corrupting the other.

### 3. Product explanation versus directness

The current app appears to explain several behaviors in long-form copy.
That may be necessary in places, but a redesign should question whether interface structure, naming, and defaults can reduce the need for explanation.

### 4. Viewer controls versus device controls

Some settings concern the visual experience of a gallery.
Others concern local storage and device behavior.
These may not belong in the same mental bucket for users.

### 5. Gallery ownership versus casual viewing

A gallery owner needs editing tools.
A casual viewer may need none of them.
A redesign should consider whether all controls need to be visible in the same way to both audiences.

## What the designer should assume is negotiable

Unless engineering says otherwise, the following should be treated as negotiable:
- the existence of the gallery splash screen,
- the current navigation pattern,
- the prominence of branding on every surface,
- the grouping of settings into one long sheet,
- the placement of subscription messaging,
- the size and weight of headings,
- the number of visible actions on a gallery card,
- and whether all current tasks belong in the primary app flow.

In other words, the current arrangement should not be treated as a wireframe to refine. It should be treated as evidence of required functionality.

## What the designer should probably preserve conceptually

Even if everything is redrawn, the following seem central to the product idea:
- photographs are the point,
- the viewing canvas should feel calm,
- the product should not feel like social media,
- users can publish/open galleries from public cloud sources,
- local encrypted behavior matters,
- and gallery management exists but should remain subordinate to picture-viewing.

## Recommended design questions to answer first

Before producing polished screens, the designer should probably answer these questions:

1. What is the single clearest definition of manorama in one sentence?
2. Is the primary product a gallery viewer, a gallery manager, or a gallery publisher with a viewer attached?
3. What is the default home state after sign-in?
4. What should be visible before a user has any galleries?
5. Which controls are needed while viewing, and which can live outside the viewer?
6. Which settings are about “display”, and which are really about “device behavior”?
7. What actions truly deserve first-level visibility on a gallery card?
8. How should free-tier / subscription information appear without dominating the interface?
9. Should owner workflows and viewer workflows share the same visual shell?
10. What is the minimum interface needed to open a gallery and enjoy the photographs?

## One possible framing for the redesign

Without prescribing the final answer, a useful framing could be:

- **Primary layer:** photographic viewing.
- **Secondary layer:** choosing, opening, and organizing galleries.
- **Tertiary layer:** maintenance, device behavior, plan limits, and advanced controls.

If the redesign keeps those layers distinct, the product is likely to become calmer and easier to understand.

## What engineering will eventually need from the designer

Once a direction is chosen, engineering will likely need:
- a product map / IA,
- principal user flows,
- a definition of the viewer shell,
- a definition of the account/gallery dashboard,
- a rule for how settings are grouped,
- component patterns for gallery cards and action menus,
- and a clear policy for where monetization and device-local controls appear.

That output will be more valuable than a purely visual refresh, because the current challenge seems fundamentally architectural.
