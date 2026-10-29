# Albert Heijn API notes

What albertheijn-mcp knows about the API the Albert Heijn mobile app uses. None of it is documented or supported by Albert Heijn, so treat every line as "worked on the date it was checked". The live checks below were run on 28 October 2026 with an anonymous token, and on 29 October 2026 with a signed-in account for the account calls (section 6 and the member profile).

This builds on the work of earlier community projects, credited by their short codes in the text:

| Code  | Project                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| AG    | [gwillem/appie-go](https://github.com/gwillem/appie-go)                                         |
| FX    | [fedorov-xyz/ah-mcp](https://github.com/fedorov-xyz/ah-mcp)                                     |
| MS    | [mrserzhan/ah-mcp](https://github.com/mrserzhan/ah-mcp)                                         |
| MK    | [markooms/openclaw-skill-albert-heijn](https://github.com/markooms/openclaw-skill-albert-heijn) |
| NB    | [NickBouwhuis/Albert-Heijn-OpenAPI](https://github.com/NickBouwhuis/Albert-Heijn-OpenAPI)       |
| LIVE  | checked against the API on 28 October 2026 (anonymous) or 29 October 2026 (signed in)           |
| PROBE | found by trying calls and reading GraphQL validation messages                                   |

Auth column legend: **anon** works with an anonymous token, **user** needs a signed-in member token, **anon?** untested.

---

## 1. Hosts, headers, transport

- REST and GraphQL host: `https://api.ah.nl` (Belgium: `https://api.ah.be`, login `https://login.ah.be`, client id `appie-be-ios`, application `AHBEWEBSHOP`; AG `client.go WithSite`).
- Login host: `https://login.ah.nl`.
- GraphQL: `POST https://api.ah.nl/graphql`, body `{"query": "...", "variables": {...}}`, JSON. One endpoint for all operations.

Headers the code in AG, MS and FX sends on every call (AG `client.go setHeaders`, MS `auth.go doAHPost`):

```
User-Agent: Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)
x-client-name: appie-ios
x-client-version: 9.28
x-application: AHWEBSHOP
Accept: application/json
Content-Type: application/json
Authorization: Bearer <access_token>
```

- AG additionally sends `appie-current-order-id: <orderId>` (and `appie-current-order-hash` if known) once an order has been loaded or chosen (`GetOrder`, `SetOrderID`). Comment: "mirroring the iOS app; the API may use this (not server-side state) to determine the active order."
- AG `doc/albertheijn_api.md` (mitmproxy capture of the iPad app) shows different spellings: `x-clientname: ipad`, `x-clientversion: 9.28`, plus `x-accept-language: nl-NL`, `x-fraud-detection-installation-id: <uuid>`, `x-correlation-id: <uuid>`, and for GraphQL `x-apollo-operation-name`, `x-apollo-operation-type`, `apollographql-client-name: nl.ah.Appie-apollo-ios`, `apollographql-client-version: 9.28-260102201630`. No repo's code sends these and LIVE shows they are not required.
- MK sends a shorter UA `Appie/9.28 (iPhone; iOS)`; works for MK.

LIVE minimum (2026-10-28):

- REST `/mobile-services/*`: `Authorization` + `x-application: AHWEBSHOP`. Without `x-application` search returns **500** `"Can not find application: 'null'"`. Without a token: **401**.
- GraphQL: `Authorization` alone is enough. Without a token: **401** `{"error":"unauthorized","error_description":"Missing valid security token"}`.
- Error bodies may be gzip-encoded even when you did not ask; send `Accept-Encoding: gzip` and decode (curl `--compressed`).

Error shapes:

- REST 4xx/5xx: Spring problem JSON `{"detail","instance","status","title","type","error","message"}` (LIVE), or `{"code","message"}` with codes like `SESSION_EXPIRED`, `INVALID_CAPTCHA` (AG doc). Order-state conflict: 409 with `message` holding an escaped JSON string (AG doc).
- GraphQL validation failure: HTTP **400**, `errors[].extensions.code = "GRAPHQL_VALIDATION_FAILED"`; messages name the missing/unknown field or argument, which is how arguments can be discovered (introspection is disabled, AG `doc/search-api.md`).
- GraphQL resolver failure: HTTP **200**, `data` null or partial, `errors[].message = "Subgraph errors redacted"` (LIVE). Always check `errors`.
- Mutations return `{status, errorMessage}`; `status` is `"SUCCESS"` on success; FX notes some mutations omit `status` while still returning a valid `result`.

Rate limits: AG README: AH sends no back-off headers. FX caps 4 concurrent requests per user token and retries 429 (all requests) and 5xx (reads only) with backoff, honouring `Retry-After` if present (FX `internal/ah/client.go`).

Schema reference: AG `doc/graphql-schema-20260118.md` lists 1124 object types and every Query/Mutation field with return types, but no argument lists.

---

## 2. Auth

| Step                | Call                                                                                                                                                                                  | Auth    | Source                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Anonymous token     | `POST https://api.ah.nl/mobile-auth/v1/auth/token/anonymous` body `{"clientId":"appie"}`                                                                                              | none    | AG `auth.go` (uses `appie-ios`), LIVE (both `appie` and `appie-ios` return 200, no other headers needed) |
| Browser login       | `GET https://login.ah.nl/login?client_id=appie-ios&response_type=code&redirect_uri=appie://login-exit`                                                                                | browser | AG `auth.go loginURL`, FX `ahlogin.LoginPath`, MS, MK                                                    |
| Redirect            | AH ends the flow with `302 Location: appie://login-exit?code=<code>` (FX diagram); AG also rewrites `appie://login-exit` inside HTML/JS/JSON bodies, so it may appear client-side too |         | FX README, AG `login.go`                                                                                 |
| Code exchange       | `POST /mobile-auth/v1/auth/token` body `{"clientId":"appie-ios","code":"<code>"}`                                                                                                     | none    | AG `auth.go exchangeCode`, MS `exchangeCodeAndSave`, FX `ahlogin.Exchange`                               |
| Refresh             | `POST /mobile-auth/v1/auth/token/refresh` body `{"clientId":"appie-ios","refreshToken":"<rt>"}`                                                                                       | none    | AG, MS, FX; NB uses `clientId: "appie"`                                                                  |
| Logout              | `POST /mobile-auth/v1/auth/token/logout` body `{"clientId":"appie-ios","refreshToken":"<rt>"}`                                                                                        | user    | AG doc only (not implemented)                                                                            |
| Federate (webviews) | `POST /mobile-auth/v1/auth/federate/code` (body not documented)                                                                                                                       | user    | AG doc only                                                                                              |

Token response (all three token calls): `{"access_token":"<numericId>_<uuid>","refresh_token":"<uuid>","expires_in":<seconds>, "member_id"?: "..."}`. AG/FX types include optional `member_id`; LIVE anonymous responses do not contain it. The numeric prefix of an anonymous access token is an anonymous member id (it shows up as `memberId=` in search `links`).

Lifetimes:

- Anonymous: `expires_in: 604798` (about 7 days), LIVE, matches AG doc.
- Logged-in: no repo measured it. AG stores `expiresAt = now + expires_in` and refreshes lazily when expired; MS refreshes when less than 60 s remain; FX assumes 15 min when `expires_in` is missing and states "AH rotates refresh tokens: the old one is invalid afterwards" (FX `ahlogin.go`). LIVE on an anonymous token: refresh returned a new pair and the old refresh token still worked once more, so rotation enforcement for anonymous tokens is loose. Treat user refresh tokens as single-use and persist the new one immediately.
- Bad code: `400 {"message":"Incorrect request send by client","status":400}` (LIVE).

Login page facts (FX README, verified with a real account 2026-10-01 including 2FA):

- `login.ah.nl` is a Next.js app with root-relative assets (`/login/_next/...`); proxying it under a path prefix breaks it. FX proxies it from the root of its own origin.
- It uses an invisible hCaptcha that rejects the host `localhost`; use `http://127.0.0.1:<port>` for local proxies.
- Akamai bot scripts under `/akam/...` are blocked by ad blockers, leaving the "Inloggen" button disabled. The response carries about 4.5 KB of headers (nginx default buffers 502).
- No `state` parameter exists, so the proxy must bind the code to the pending sign-in itself.
- LIVE: the login URL returns 403 to curl's default UA and 200 to a Chrome UA.

How each repo captures the code:

- AG `login.go Login()`: starts a reverse proxy on `127.0.0.1:<random>` to `login.ah.nl`, opens the default browser on `http://127.0.0.1:<port>/login?...`, rewrites any `Location: appie://...` to `/callback?code=...`, rewrites `appie://login-exit` and `https://login.ah.nl` in text bodies, strips CSP/HSTS/X-Frame-Options, strips `Secure`/`SameSite`/`Domain` from cookies (Safari drops Secure cookies on http). Then exchanges the code.
- MS `auth.go StartOAuthFlow`: same proxy idea on a configurable host/port (`0.0.0.0:<port>` for remote use), additionally rewrites `Origin`/`Referer` to `login.ah.nl`, 5 min timeout, returns the URL for the user to open (`--remote`) or opens the browser locally.
- FX `internal/ahlogin/proxy.go` + `internal/oauth`: full OAuth 2.1 authorization server for MCP clients (PKCE, DCR, CIMD). "Sign in with Albert Heijn" sets a one-time HttpOnly cookie and relays `login.ah.nl` from its root; the `appie://` redirect is rewritten to `/oauth/ah/<sid>/callback`. AH tokens are sealed (XChaCha20-Poly1305) inside the tokens it issues; nothing stored server-side.
- MK `appie-cli login`: manual paste. A local page links to the AH login URL; the browser fails on the `appie://` redirect; the user copies the address-bar URL into a form, which posts to `127.0.0.1:<port>/callback`. Fallback `appie-cli exchange-code "appie://login-exit?code=XXX"` accepts the full URL or the bare code.

---

## 3. Products

### 3.1 REST search (anon)

`GET /mobile-services/product/search/v2?query=<q>&page=<0-based>&size=<n>&sortOn=<sort>` (AG `products.go`, FX `products.go`, NB, LIVE)

- Optional `taxonomyId=<categoryId>` restricts to a category; with no `query` it browses the category (AG doc adds `adType=TAXONOMY`). LIVE: `taxonomyId=1730` alone returned 2016 products.
- `sortOn` values (LIVE, echoed in the response): `RELEVANCE, PRICEHIGHLOW, PRICELOWHIGH, TAXONOMY, PURCHASE_FREQUENCY, PURCHASE_DATE, PURCHASE_DEPARTMENT, NUTRISCORE`. AG doc's `PRICE_ASC/PRICE_DESC` is wrong (AG `search-api.md` has the right list).
- Filter params are ignored (AG `search-api.md`; LIVE: `bonus=true`, `bonus=ANY`, `brand=AH`, `nutriscore=A` left `totalElements` unchanged). `filters=<anything>` returns 500 `IndexOutOfBoundsException`. For bonus-only, AG/FX over-fetch `size = limit*5` and keep `isBonus`, or use GraphQL search (3.5).
- No enforced max `size` (AG tested 1000). Sponsored items can push the count slightly above `size`.
- Response top keys: `page {size,totalElements,totalPages,number}`, `products[]`, `filters[]` (facet metadata: `brand`, `taxonomy`, `intolerance`, `diet`, `nutriscore`, `bonus`, property toggles; each `{id,label,type,booleanFilter,options[{id,label,count}]}`), `taxonomyNodes`, `sortOn[]`, `links`, `ads`, `configuration`.
- Product fields that matter (LIVE): `webshopId` (the product id used everywhere), `hqId`, `title`, `brand`, `salesUnitSize`, `unitPriceDescription` (e.g. "prijs per liter €1.19", null for bundles), `priceBeforeBonus` (regular price), `currentPrice` (bonus price, **null when not on bonus**), `isBonus`, `isBonusPrice`, `bonusMechanism` ("2 voor 5.50", "5% volume voordeel"), `discountLabels[]`, `bonusStartDate`, `bonusEndDate`, `promotionType` (`NATIONAL`, `AHONLINE` = online only, `PERSONAL`), `isStapelBonus`, `bonusSegmentId`, `mainCategory`, `subCategory`, `nutriscore` ("B" or null), `images[] {width,height,url}` (800/400/200/80/48), `availableOnline`, `isOrderable`, `orderAvailabilityStatus` ("IN_ASSORTMENT"), `isPreviouslyBought` (meaningful with a user token), `propertyIcons[]`, `nix18` (age check), `isVirtualBundle` + `virtualBundleItems[{productId,quantity}]`, `isSponsored`, `descriptionHighlights` (HTML).

### 3.2 Products by ids (anon)

`GET /mobile-services/product/search/v2/products?ids=33693&ids=609672&sortOn=INPUT_PRODUCT_IDS` returns a JSON **array** of the same product objects, in input order (AG `GetProductsByIDs`, LIVE). AG calls this the only reliable source of `bonusMechanism` text; FX uses search for Nutri-Score.

### 3.3 Product detail (anon)

`GET /mobile-services/product/detail/v4/fir/<webshopId>` (AG, FX, LIVE)

Response: `{productId, productCard, tradeItem, properties, disclaimerText}`.

- `productCard`: same fields as a search product minus `currentPrice`/`nutriscore` (LIVE for a non-bonus item), plus `subCategoryId`, `isFavorite`, `properties`.
- Nutri-Score: top-level `properties.nutriscore: ["B"]` (LIVE). FX re-searches by title because it did not find it on the card; the `properties` map has it.
- Diet/allergy flags: `properties` keys like `sp_include_dieet_vegetarisch`, `sp_exclude_intolerance_geen_lactose`, `np_lokaal`.
- `tradeItem` (GS1 data, LIVE): `gtin` ("08710400058519"), `foodAndBeverageIngredientStatement` (ingredients as one string), `allergenInformation[].items[] {typeCode{value,label}, levelOfContainmentCode{value: "CONTAINS"|"FREE_FROM"|..., label}}`, `nutritionalInformation.nutrientHeaders[] {nutrientBasisQuantity{value,measurementUnitCode}, nutrientDetail[] {nutrientTypeCode{value,label}, quantityContained[{value, measurementUnitCode{value}}]}}`, `measurements.netContent`, `description.regulatedProductName`, `contactInformation`, `consumerInstructions`, `packagingMarking`.

### 3.4 GraphQL product (anon)

Simpler nutrition shape (AG `products.go fetchProductNutritionQuery`, FX, LIVE):

```graphql
query FetchProduct($productId: Int!) {
  product(id: $productId) {
    id
    title
    brand
    salesUnitSize
    tradeItem {
      gtin
      nutritions {
        nutrients {
          type
          name
          value
        }
      }
    }
    priceV2 {
      now {
        amount
      }
      was {
        amount
      }
    }
  }
}
```

`nutrients[]` look like `{"type":"ENER-","name":"Energie","value":"200.0 kJ (48.0 kcal)"}`. `products(...)` (plural) requires `productsInput: [ProductsInput!]!` (PROBE; field names of `ProductsInput` unknown).

### 3.5 GraphQL faceted search (anon)

Source: AG `doc/search-api.md`, LIVE.

```graphql
query SearchProducts($input: SearchProductsInput!) {
  searchProducts(input: $input) {
    totalFound
    products {
      id
      title
      brand
      category
      salesUnitSize
      icons
      priceV2 {
        now {
          amount
        }
        was {
          amount
        }
        discount {
          description
          promotionType
          segmentType
        }
        promotionLabel {
          tiers {
            mechanism
            description
          }
        }
      }
      imagePack {
        small {
          url
          width
          height
        }
      }
      availability {
        isOrderable
      }
    }
    facets {
      facets {
        label
        name
        type
        options {
          name
          value
          matches
          selected
        }
      }
    }
  }
}
```

Variables: `{"input":{"query":"kaas","sortType":"RELEVANCE","searchInput":{"facets":[{"label":"bonus","values":{"values":[true]}},{"label":"product.brand.name","values":{"values":["ah"]}}],"page":{"number":0,"size":36}}}}`.

- `sortType`: `RELEVANCE`, `PRICE_LOW_HIGH`, `PRICE_HIGH_LOW` (not `NUTRI_SCORE`).
- Facet labels (slug values, `bonus` is the only boolean): `bonus`, `product.brand.name`, `product.properties.nutri-score` (`a`..`e`), `product.properties.dieet`, `product.properties.allergie`, `taxonomy.nodes` (numeric ids as strings), plus query-specific ones returned in `facets`. `price` (RANGE) and `previouslyBought` return 400 via the mobile API (AG).
- iOS app extras (AG): `extraConsents: ["ANALYSIS","ADS_INSIDE","ADS_OUTSIDE"]`, `searchInput.intent: {intent:"ONLINE", orderId:<activeOrderId>}`, `page.merged:false`.
- `icons` carry `NUTRISCORE_D`, `VEGETARIAN`, etc. `category` is a path like "Kaas/Jonge kaas (plakken)".
- **Disagreement:** AG (Mar 2026) says `priceV2.discount` is null for multi-buy deals. LIVE today: `discount.description: "2 voor 5.50"` with `promotionType: "NATIONAL"` came back for AH Goudse kaas. Keep the REST enrichment fallback but do not rely on GraphQL being empty.

### 3.6 Barcode / GTIN (anon, PROBE)

`GET /mobile-services/product/search/v1/gtin/<gtin>` returns one product object (search shape, includes `webshopId`). Works with 13-digit EAN and 14-digit GTIN (LIVE: `8710400058519` and `08710400058519` both resolve to 33693). Not in any of the five repos. `/v2/gtin/...` is 404; REST search with the GTIN as `query` returns 0 hits.

### 3.7 Categories / taxonomy (anon)

- `GET /mobile-services/v1/product-shelves/categories` returns 28 top-level `{id, name, slugifiedName, images, nix18}` (PROBE, LIVE). Example ids: 6401 Groente/aardappelen, 1192 Kaas, 1730 Zuivel/eieren, 5881 Diepvries.
- `GET /mobile-services/v1/product-shelves/categories/<id>/sub-categories` returns `{parent, children[]}` with the same fields (AG doc, LIVE).
- List products in a category: REST search with `taxonomyId` (3.1) or GraphQL facet `taxonomy.nodes`.
- GraphQL `productTopLevelTaxonomies`, `productTaxonomyById`, `searchTaxonomies` exist (schema); field names differ from REST (`slugifiedName` is invalid on `ProductTaxonomy`, PROBE).

### 3.8 POS id to webshop id (anon?)

`productConvertId(sourceId: Int!): Int` maps a receipt line id to a webshop id; `-1` means no mapping. Batch with aliases: `query Convert { p0: productConvertId(sourceId: 767898) p1: productConvertId(sourceId: 823326) }` (AG doc + `receipts.go ConvertPOSIDs`). Only feed it receipt ids; arbitrary ints map to unrelated products.

---

## 4. Bonus and offers

### 4.1 Bonus weeks and sections (anon)

`GET /mobile-services/bonuspage/v3/metadata` (AG `bonus.go`, FX `bonus.go`, LIVE)

- `periods[] {bonusStartDate (Monday), bonusEndDate (Sunday), nextPeriodVisibleFrom, bonusFolderUrl, voordeelshopFolderUrl, tabs[]}`. LIVE today: one period 2026-10-26..2026-11-01, `nextPeriodVisibleFrom: 2026-10-30` (next week's period is added from then).
- `tabs[] {description, urlMetadataList[] {url, count, bonusType, description}}`. Anonymous tabs: "Uitgelicht", "Alle Bonus". `bonusType`: `SPOTLIGHT`, `NATIONAL` (one entry per category), `GALL`, `GALLCARD`, `ETOS`.
- `url` is relative, e.g. `bonuspage/v2/section?application=AHWEBSHOP&date=2026-10-26&promotionType=NATIONAL&category=Kaas`; prefix with `/mobile-services/` (FX `PeriodOffers`).
- GraphQL `bonusPeriods { startDate endDate }` also works anonymously (PROBE).

`GET /mobile-services/bonuspage/v2/section?application=AHWEBSHOP&date=<Monday>&promotionType=NATIONAL&category=<description>` (AG, FX, NB, LIVE)

- Response `{sectionType, sectionDescription, sectionImage, bonusGroupOrProducts[]}`; each entry is `{bonusGroup: {...}}` or `{product: {...search product...}}`.
- `bonusGroup` fields (LIVE): `id` (string, = segment id), `segmentId` (number), `segmentDescription` ("Alle Eru"), `discountDescription` ("2 + 1 GRATIS"), `discountLabels[]`, `category`, `promotionType`, `segmentType`, `bonusStartDate`, `bonusEndDate`, `images`, `products[]` (LIVE: often **empty**), `exampleFromPrice`/`exampleForPrice` (often null; for multi-piece deals FX found they can quote the whole deal, not one piece), `extraDescriptions[]`, `exceptionRule` ("*M.u.v. Biologisch"), `storeOnlyPromotion` (not valid online), `isStapelBonus`, `offerId`, `activationStatus` (personal only).
- `promotionType` instead of `category`: `GALL`, `GALLCARD`, `ETOS`, `AHONLINE` (NB).
- NB's 2022 category names are stale; take names from metadata.

`GET /mobile-services/bonuspage/v2/section/spotlight?application=AHWEBSHOP&date=<Monday>` folder highlights, same shape (AG, LIVE).

Products inside a group (anon, AG `bonus.go fetchBonusGroupProductsQuery`, FX, LIVE):

```graphql
query FetchBonusPromotionWithProducts($id: String, $periodStart: String, $periodEnd: String) {
  bonusPromotions(
    input: {
      id: $id
      periodStart: $periodStart
      periodEnd: $periodEnd
      filterUnavailableProducts: true
      forcePromotionVisibility: true
      showAllPromotionSegments: true
    }
  ) {
    id
    title
    productCount
    products {
      id
      title
      brand
      salesUnitSize
      availability {
        isOrderable
      }
      priceV2(
        periodStart: $periodStart
        periodEnd: $periodEnd
        filterUnavailableProducts: true
        forcePromotionVisibility: true
      ) {
        now {
          amount
        }
        was {
          amount
        }
        promotionLabel {
          tiers {
            mechanism
            description
          }
        }
      }
    }
  }
}
```

Variables `{"id":"821906","periodStart":"2026-10-26","periodEnd":"2026-11-01"}`. LIVE: 11 Eru products, tier `{"mechanism":"X_PLUS_Y_FREE","description":"2+1 gratis"}`. FX marks the next-week variant UNVERIFIED.

`discountLabels[].code` values and their maths (FX `ComputeTiers`): `DISCOUNT_PERCENTAGE` / `DISCOUNT_TIERED_PERCENT` (`percentage`, `count`), `DISCOUNT_X_FOR_Y` / `DISCOUNT_TIERED_PRICE` (`price` is the total for `count`), `DISCOUNT_FIXED_PRICE`, `DISCOUNT_X_PLUS_Y_FREE` (`count` + `freeCount`), `DISCOUNT_ONE_HALF_PRICE` (2e halve prijs), `DISCOUNT_WEIGHT` (`price` per `count` `unit`), `DISCOUNT_BONUS`, `DISCOUNT_BUNDLE` (pakketkorting), `DISCOUNT_BUNDLE_BULK` (LIVE, "5% volume voordeel").

Basket price with bonus applied (anon, AG doc, LIVE):

```graphql
query FetchTotalPrice($products: [PriceLineItem!]!) {
  totalPrice(products: $products) {
    withoutDiscount {
      amount
    }
    discount {
      amount
    }
  }
}
```

`{"products":[{"id":2600,"quantity":2},{"id":33693,"quantity":1}]}` returned `withoutDiscount 7.69, discount 0.40` (2 voor 5.50 applied). Final = without minus discount.

### 4.2 Personal bonus (Bonus Box) (user)

Three generations; prefer the first:

1. `GET /mobile-services/bonuspage/v1/personal?bonusStartDate=YYYY-MM-DD` (Monday of the week). Same section shape; entries carry `activationStatus` (e.g. `ACTIVATED`). AG `bonus.go GetPersonalBonus` (2026 code) and FX `PersonalOffers` (live-verified 2026-10-01).
2. `GET /mobile-services/bonuspage/v2/section/personal?application=AHWEBSHOP&date=<Monday>` (AG doc Feb 2026, NB 2023). Older.
3. `GET /mobile-services/bonuspage/v1/choose-and-activate?bonusStartDate=<Monday>` (NB 2023). Oldest.

- GraphQL alternative (AG doc, from app capture): `bonusPromotions(filterSet: APP_BONUS_BOX, input: {periodStart, periodEnd, orderId, filterUnavailableProducts, forcePromotionVisibility, states: [ACTIVATABLE, ACTIVATED]})` plus `bonusPersonalPromotionBundles(validOn: $periodStart) { maximumActivations error }`.
- Activation (a write, no repo uses it on purpose): `PATCH /mobile-services/bonuspage/v1/activate/<offerId>` form-encoded `segmentId=<id>&startDate=<Monday>` (NB 2023); GraphQL mutation `bonusActivatePersonalPromotion` exists (schema only, args unknown). FX lists personal offers read-only.
- Previously-bought bonus: `GET /mobile-services/bonuspage/v2/section/previously-bought?application=AHWEBSHOP&date=<Monday>` (AG doc only).

### 4.3 Koopjes / last-chance markdowns

AG `koopjes.go`, MS `ah_get_last_chance_items`, FX `ah_last_chance`:

```graphql
query BargainItems($storeId: String!) {
  bargainItems(storeId: $storeId) {
    product {
      id
      title
      brand
      salesUnitSize
    }
    categoryTitle
    markdown {
      markdownType
      markdownExpirationDate
      markdownPercentage
    }
    stock
    bargainPrice {
      priceWas
      priceNow
    }
  }
}
```

`storeId` is a **string**. `bargainPrice` values are strings. LIVE with an anonymous token on stores 2225, 1147, 1081: HTTP 200, `data: null`, `"Subgraph errors redacted"`; `bargainCategories(storeId:)` same. AG's `koopjes` CLI refuses to run without login, and MS/FX call it with the member's token, so treat as **user**.

---

## 5. Basket, active order, slots, checkout

### 5.1 Domain model (FX README, newest)

- The app's shopping list (Boodschappenlijst) is the GraphQL `basket`: `itemsInList` (products) + `notes` (free text).
- A real online order exists only after the user picks a delivery or pickup slot in the AH app. Then `basket.itemsInOrder` is filled and REST `/order/v1/summaries/active` returns it.
- While an order is active AH keeps no separate list: products added "to the list" go into the order (quantities added) and free-text notes are rejected.
- FX detection heuristic (UNVERIFIED for the positive case): active if `itemsInOrder != null || summary.shoppingType != "" || summary.deliveryDate != ""`.

### 5.2 GraphQL basket (user)

FX `internal/ah/basket.go` (verified 2026-10-01):

```graphql
query MCPBasket {
  basket {
    id
    canChangeDelivery
    itemsInList {
      id
      quantity
      originCode
      position
      isStrikethrough
      product {
        id
        title
        priceV2 {
          now {
            amount
          }
          was {
            amount
          }
        }
      }
    }
    itemsInOrder {
      id
      quantity
      allocatedQuantity
      originCode
      position
      isClosed
      product {
        id
        title
        priceV2 {
          now {
            amount
          }
          was {
            amount
          }
        }
      }
    }
    notes {
      description
      quantity
      searchTerm
      originCode
      position
      isStrikethrough
    }
    summary {
      quantity
      isCancellable
      shoppingType
      deliveryDate
      price {
        priceBeforeDiscount {
          amount
        }
        priceAfterDiscount {
          amount
        }
        totalPrice {
          amount
        }
        discount {
          amount
        }
      }
    }
  }
}
```

AG doc variant `FetchMyListBasket($input: BasketInput, $states: [BonusSegmentState!])` additionally selects `products {...}`, `summary.lastUserChangeDateTime` and a sibling `order { delivery { address {...} date startTime endTime status id shiftCode pickupLocationId } }`; it calls the list field `products`, FX calls it `itemsInList` (FX is newer and live-verified).

Mutations (FX, verified 2026-10-01):

```graphql
mutation MCPBasketItemsAdd($items: [BasketMutation!]!)    { basketItemsAdd(items: $items)    { status errorMessage result { ...same fields... } } }
mutation MCPBasketItemsUpdate($items: [BasketMutation!]!) { basketItemsUpdate(items: $items) { status errorMessage result { ...same fields... } } }
```

`items: [{"id": <webshopId>, "quantity": <n>}]`. `basketItemsAdd` adds; `basketItemsUpdate` sets the quantity, `0` removes. With an active order these hit the order (FX). Schema also has `basketItemsDelete`, `basketItemReplace`, `basketMergeList`, `basketDeleteV2`, `orderMergeById` (no repo uses them).

### 5.3 REST active order (user)

- `GET /mobile-services/order/v1/summaries/active?sortBy=DEFAULT` (AG `GetOrder`, FX `GetActiveOrder`): `{id, state ("REOPENED", ...), shoppingType ("DELIVERY"), totalPrice {priceBeforeDiscount, priceAfterDiscount, priceDiscount, priceTotalPayable}, deliveryInformation {deliveryDate, deliveryStartTime, deliveryEndTime, address{street,houseNumber,zipCode,city}}, orderedProducts[] {amount, quantity, product{webshopId,title,brand,images}}}`. Errors when no active order (AG test skips on error).
- `PUT /mobile-services/order/v1/items?sortBy=DEFAULT` body `{"items":[{"productId":553353,"quantity":1,"originCode":"PRD","description":"","strikethrough":false}]}` sets the quantity for each product, `0` removes; duplicate `productId`s in one request are rejected, merge them first (AG `AddToOrder`). FX: active-order writes UNVERIFIED.
- `GET /mobile-services/order/v1/<orderId>/details-grouped-by-taxonomy` (any order, AG, FX): `{orderId, orderState ("DELIVERED", ...), deliveryDate, closingTime ("2025-12-08T22:59:00Z"), deliveryType ("HOME"), deliveryTimePeriod {startDateTime, endDateTime, startTimeUtc, endTimeUtc}, groupedProductsInTaxonomy[] {taxonomyName, orderedProducts[] {amount, quantity, allocatedQuantity, position, product{webshopId,title,brand,salesUnitSize,priceBeforeBonus,currentPrice (null for group deals),isBonus,bonusMechanism}}}, invoiceId, cancellable, reopenable, orderPayments, address, orderMethod ("PLANSERVICE")}`.
- `GET /mobile-services/order/v1/invoice/download?invoiceId=<invoiceId>` returns a PDF (AG doc).
- `GET /mobile-services/order/v1/<orderId>/checkout` returns `{kassaKoopjes, missingBonus, nonChosen, nonDeliverables, recommendedProducts, samples, showMakeCompleet}`, a pre-checkout check, read-only (AG doc).
- `PUT /mobile-services/order/v1/<orderId>/state?orderBy=DEFAULT` with plain-text body `RESET` (AG doc). Meaning not documented; after the closing time it returns `409 "Unable to update, closing time has passed for order"`. Treat as destructive.

### 5.4 Order lists, history, tracking (user)

```graphql
query OrderFulfillments {
  orderFulfillments(status: OPEN) {
    # CLOSED for past orders
    result {
      orderId
      statusCode
      statusDescription
      shoppingType
      transactionCompleted
      modifiable
      totalPrice {
        totalPrice {
          amount
        }
        discount {
          amount
        }
      }
      delivery {
        status
        method
        slot {
          date
          dateDisplay
          timeDisplay
          startTime
          endTime
        }
        address {
          street
          houseNumber
          houseNumberExtra
          city
          postalCode
        }
      }
    }
  }
}
```

AG `order.go` (OPEN), MS and FX (CLOSED; FX adds `discount`, verified 2026-10-01). `delivery.status` seen: `SUBMITTED`, `CONFIRMED` (AG CLI). Schema also has `orderFulfillment`, `orderFulfillmentsByDateRange`, `orderReceipt`, `orderReport`.

- Track and trace: `query FetchOrderTrackTrace($orderId: Int!) { order(id: $orderId) { delivery { trackAndTraceV2 { orderId type orderType message etaBlock { range { start end } } } } } }` (AG doc; `type` e.g. `DELIVERED`, `IN_TRANSIT`, `PREPARING`). Older REST: `GET /mobile-services/v1/tracktrace/delivery-state-information` (NB 2023).
- Minimum order value: `orderValueLimits(orderId: Int!) { minimumOrderValue { amount } submittable }` (AG doc).

### 5.5 Reopen / revert a submitted order (user, changes a real order)

```graphql
mutation OrderReopen($id: Int!) {
  orderReopen(id: $id) {
    status
    errorMessage
  }
}
mutation OrderRevert($id: Int!) {
  orderRevert(id: $id) {
    status
    errorMessage
  }
}
```

AG `order.go`. Flow used by AG CLI/tests: `orderFulfillments(OPEN)` → if status SUBMITTED/CONFIRMED call `orderReopen` → send `appie-current-order-id` → `PUT /order/v1/items` → `orderRevert`. AG README: reopen makes that order the server-side active order, which also shifts bonus visibility to its delivery week; always revert when done. AG's round-trip test (on an empty €0 "PLANSERVICE" order) saw the fulfillment total change after `PUT items` with no extra confirm call. Whether `orderRevert` keeps or discards edits is not established by any repo (the test clears before reverting). FX refuses reopen/revert entirely.

### 5.6 Delivery slots (read only in prior art)

- REST `GET /mobile-services/v1/slots?postalCode=1506%20MA&houseNumber=11&street=Provincialeweg&city=Zaandam&productIds=2708` (NB 2023 only, not re-tested). Response: `[{date, freeDelivery, slots[] {startTime, endTime (UTC ISO), serviceCharge, defaultServiceCharge, eco, nudgeType[], discountType, shiftCode, status ("OPEN"|"FULL"), productionRunCode, deliveryLocationId}}]`.
- GraphQL `orderDeliverySlots`, `orderPickupSlots`, `orderLeadTime`, `deliveryBundles` exist in the schema; arguments unknown.
- **Reserving a slot: no repo has it.** Not found in REST or GraphQL usage.

### 5.7 Placing / confirming an order

- **No repo places, checks out, cancels or deletes an order.** FX excludes "delivery slots, checkout, order creation, or reopening/editing a placed order" by design; AG `plan.md` lists checkout as a future step.
- Schema-only (Jan 2026 dump, args unknown): query `checkoutValidateOrder`, mutations `checkoutOverview`, `checkoutConfirmOrder`, `checkoutConfirmOrderV4`, `checkoutConfirmFallbackSubmission` (types mention prepayments, wallet, purchase-stamp booklets, `CheckoutRedirectAction`, so payment is part of it), `orderSubmitActionCode`, `orderCancel`, `orderDelete`, `orderActiveDelete`.
- What is known about commitment: an order has a `closingTime` (UTC, the evening before delivery in AG's sample); after it, updates return 409. Edits made to an open or reopened order before the closing time are what gets picked and charged.
- Treat as real and irreversible from an MCP: `checkoutConfirmOrder*`, `checkoutConfirmFallbackSubmission`, `orderSubmitActionCode`, `orderCancel`, `orderDelete`, `orderActiveDelete`, `basketDeleteV2`, `PUT .../state RESET`, and any `PUT /order/v1/items` or `basketItems*` while the order is SUBMITTED/CONFIRMED/REOPENED (changes a placed order). Reopen/revert and Bonus Box activation are state changes with unclear undo.

---

## 6. Shopping list (lijstje)

Two different things share the name:

- **Boodschappenlijst**: the single main list in the app. Newest model: GraphQL `basket.itemsInList` + `notes` (5.2).
- **Mijn lijstjes / favourite lists**: named lists with UUIDs (6.3).

### 6.1 Main list, read (user)

- Newest: GraphQL `basket` (5.2): products with `quantity`, `isStrikethrough` (checked), `position`; notes with `description`, `quantity`, `isStrikethrough`. FX gives entries stable refs `product:<id>` / `note:<index>`.
- REST v2: `GET /mobile-services/shoppinglist/v2/items` (AG doc, MS) or with `?orderBy=userInput&orderByParam=0` (MK, its Apr 2026 fix). Response `{id, items[] {listItemId (always 0, MS), strikedthrough, quantity, description, type ("SHOPPABLE"), originCode ("PRD" or "TXT"), position, sorting{position}, productDetails{product{webshopId,title}}, vagueTermDetails{searchTermValue,bonus}}, dateLastSynced, dateLastSyncedMillis, activeSorting, storeNumber}`. Note the read spelling `strikedthrough` vs write spelling `strikeThrough`.

### 6.2 Main list, add / remove / check (user)

- Products: `basketItemsAdd` / `basketItemsUpdate` (quantity 0 removes) (FX, verified 2026-10-01).
- Free-text notes (FX, verified 2026-10-01): `PATCH /mobile-services/shoppinglist/v2/items?orderBy=userInput&orderByParam=0` body `{"items":[{"description":"Slager: kipfilet","quantity":1,"type":"SHOPPABLE","originCode":"PRD","strikeThrough":false}]}`; `quantity: 0` removes the note. FX defaults `originCode` to `PRD` even for notes; AG doc says `TXT` is used for free text in reads.
- Older v2 product add (AG `AddToShoppingList`, MK, NB): same PATCH with `{"productId":482500,"quantity":1,"type":"SHOPPABLE","originCode":"PRD","description":"<title>","searchTerm":"<title>","strikeThrough":false}`; response is the full list. Remove = same item with `quantity: 0` (MS, MK, NB). AG/MS use the path without query params; MK needed `?orderBy=userInput&orderByParam=0` after an app change.
- Check off: **no repo has a verified write for the main list.** NB documents `strikeThrough` as an optional PATCH field; MS says the v2 list has no usable item ids so its check tool only targets favourite lists; FX lists "checking/unchecking list items" as out of scope. Untested option: v2 PATCH with `strikeThrough: true`.
- AG `CheckShoppingListItem`: `PATCH /mobile-services/lists/v3/lists/items/<itemId>` body `{"checked": true}` (code only, not in its doc or tests; for favourite-list item ids).

### 6.3 Favourite lists (user)

- List all: GraphQL `favoriteListV2(ids: [])` with an **empty** id list returns every list, `[{id (lowercase uuid), description, totalSize}]` (PROBE, LIVE 2026-10-29). A new account has one list, "Mijn favorieten".
- `GET /mobile-services/lists/v3/lists?productId=<any int>` (AG) now answers `404 {"error":"not_found","error_description":"404 NOT_FOUND"}` for every variant tried, including `/v2/lists` and no `productId` (LIVE 2026-10-29).
- Items: GraphQL `favoriteListV2(ids: [String!]!, productIds: [Int!]) { id description totalSize imageUrl items { id productId quantity } }` (AG `GetShoppingListItems` passes **uppercase** UUIDs; LIVE: uppercase works). REST `GET /mobile-services/lists/v3/lists/<id>/items` (MK) not checked.
- Add: `mutation AddProductsToFavoriteList($favoriteListId: String!, $products: [FavoriteListProductMutation!]!) { favoriteListProductsAddV2(id: $favoriteListId, products: $products) { status errorMessage } }`, products `[{productId, quantity}]` (AG, LIVE 2026-10-29).
- Remove: `mutation DeleteProductsFromFavoriteList($favoriteListId: String!, $itemIds: [String!]!) { favoriteListProductsDeleteV2(id: $favoriteListId, itemIds: $itemIds) { status errorMessage } }` (AG; item ids come from `favoriteListV2.items[].id`; LIVE 2026-10-29).
- Schema-only: `favoriteListAddV2`, `favoriteListChangeV2`, `favoriteListDeleteV2`, sharing mutations.

---

## 7. Receipts and purchase history (user)

### 7.1 Kassabonnen (in-store receipts)

Newest (AG `receipts.go`, FX `details.go` pages past 100, live-verified 2026-10-01):

```graphql
query FetchPosReceipts($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: { offset: $offset, limit: $limit }) {
    posReceipts {
      id
      dateTime
      totalAmount {
        amount
      }
    }
  }
}
query FetchReceipt($id: String!) {
  posReceiptDetails(id: $id) {
    id
    memberId
    products {
      id
      quantity
      name
      price {
        amount
      }
      amount {
        amount
      }
    }
    discounts {
      name
      amount {
        amount
      }
    }
    payments {
      method
      amount {
        amount
      }
    }
  }
}
query FetchPosReceiptPdf($id: String!) {
  posReceiptPdf(id: $id) {
    pdfBase64
  }
}
```

- `products[].id` is a POS id; map to webshop ids with `productConvertId` (3.8). `externalIds` is always null (AG). `quantity` is a Float in the schema; `price` can be null.
- More fields in schema `PosReceipt`: `storeInfo`, `address`, `storeType`, `discountTotal`, `discountPersonal`, `total`, `vat`, `stamps`, `transaction`, `loyaltyCards`.
- Older REST: `GET /mobile-services/v1/receipts` and `GET /mobile-services/v2/receipts/<transactionId>` (AG doc, NB 2023). MK's skill table says receipts are "broken, 503" (appie-go v0.0.4 era). Use GraphQL.

### 7.2 Previously bought / purchase history

- MK (raw GraphQL, inline args): `{ productSearch(input: { query: "" previouslyBought: true size: 100 page: 0 }) { products { id title brand category } page { totalElements totalPages } } }`. Not re-tested (user data).
- Schema-only: `productPurchaseHistory` (returns `{total, products}`), `searchPreviouslyBought`, mutation `productPurchaseHistoryHideProducts`.
- REST search with a user token: `isPreviouslyBought` per product and `sortOn=PURCHASE_FREQUENCY | PURCHASE_DATE | PURCHASE_DEPARTMENT`.
- FX/MS build "frequent items" by expanding every OPEN+CLOSED fulfillment through `details-grouped-by-taxonomy`; FX `ah_purchase_history` merges receipts and orders (no dedicated endpoint).

---

## 8. Member, bonus card, stores

### 8.1 Member (user)

`query FetchMember { member { ...MemberFragment } }` with fields `id emailAddress gender dateOfBirth phoneNumber isB2B name { first last } address { street houseNumber houseNumberExtra postalCode city countryCode } cards { bonus gall airmiles } company { id name } memberships customerProfileAudiences customerProfileProperties { key value } analytics { ... }` (AG `member.go`, full fragment in AG doc). `cards.bonus` is the 13-digit Bonuskaart number. MK uses `customerProfileProperties` (age range, diet, price segment, favourite shopping day). FX uses `member` to read id and email at sign-in.
Older REST: `GET /mobile-services/member/v3/member` (`memberId, email, loyaltyCards[{id,type: "AM"|"BO"}], memberships[]`) and `/member/v3/membership` (NB 2023).

### 8.2 Stores (anon)

```graphql
query StoresSearch($filter: StoresFilterInput) {
  storesSearch(filter: $filter, limit: 5) {
    result {
      id
      name
      storeType
      phone
      distance
      address {
        street
        houseNumber
        houseNumberExtra
        postalCode
        city
        countryCode
      }
      geoLocation {
        latitude
        longitude
      }
      openingDays {
        date
        openingHour {
          openFrom
          openUntil
        }
      }
      services {
        code
      }
    }
    pageInfo {
      hasNextPage
    }
  }
}
```

- Filter fields: `postalCode` (AG `koopjes.go`, MS, FX), `location: {latitude, longitude}` (PROBE), `storeTypes: [XL]` (PROBE; `REGULAR`, `XL` seen). Not accepted: `city`, `query`, `searchText`, top-level `latitude`.
- `distance` is in metres; results are distance-ordered. `houseNumber` is a **string** here. `openingDays` is a list of weeks, each a list of days (LIVE: two weeks); AG doc shows it flat.
- Detail: `query FetchStore($storeId: Int!) { storesInformation(id: $storeId) { ...same fields... } }` (AG doc, LIVE).
- Favourite store (user): `query GetFavoriteStore { storesFavouriteStore { ... } }` (AG doc); mutation `storesSetFavouriteStore` (schema). Also `storesGeoLocationSuggestions`, `storesCityCount` (schema).

---

## 9. Recipes (Allerhande) (anon)

Search (AG doc `FetchRecipes`, LIVE):

```graphql
query FetchRecipes(
  $searchText: String
  $start: Int
  $size: PageSize
  $sortBy: RecipeSearchSortOption
  $filters: [RecipeSearchQueryFilter!]
  $recipeIds: [Int!]!
  $ingredients: [String!]
) {
  recipeSearchV2(
    searchText: $searchText
    start: $start
    size: $size
    sortBy: $sortBy
    filters: $filters
    recipeIds: $recipeIds
    ingredients: $ingredients
  ) {
    correctedSearchTerm
    page {
      total
      hasNextPage
    }
    filters {
      label
      name
      filters {
        name
        label
        group
        count
        selected
      }
    }
    result {
      id
      title
      time {
        cook
      }
      images(renditions: [D445X297]) {
        width
        height
        url
      }
      flags
      nutriScore
      tags {
        key
        value
      }
    }
  }
}
```

- `recipeIds` is required (pass `[]`). `sortBy`: `MOST_RELEVANT` (others not explored). Renditions: `S, M, D445X297, D890X594`.
- Filter input is `{group: String!, values: [String!]}` (PROBE), e.g. `{"group":"speciale-wensen","values":["vegetarisch"]}`. Groups seen: `veel-gebruikt`, `menugang`, `soort-gerecht`, `recepten-met`, `speciale-wensen`, `momenten`, `seizoen`, `kooktechniek`; values come back in `filters`.

Detail (LIVE; field names checked against schema `Recipe`/`RecipeIngredient`):

```graphql
query {
  recipe(id: 1064602) {
    id
    title
    slugifiedTitle
    description
    href
    cookTime
    ovenTime
    waitTime
    servings {
      number
      type
      isChangeable
    }
    ingredients {
      id
      text
      quantity
      quantityUnit {
        singular
        plural
      }
      name {
        singular
        plural
      }
      servingsScale
      curatedBonus
    }
    preparation {
      steps
    }
    nutritions {
      energy {
        value
        unit
      }
    }
    tags {
      key
      value
    }
    images(renditions: [D445X297]) {
      url
      width
      height
    }
  }
}
```

Web URL: `https://www.ah.nl` + `href` (e.g. `/allerhande/recept/R-R1064602/pasta-pesto`).

Ingredient to product mapping (PROBE, not in any repo):

```graphql
query {
  recipeProductSuggestionsV2(options: { recipeId: 1064602 }) {
    optional
    ingredient {
      id
      name
      quantityFloat
      quantityUnit
      completeText
    }
    productSuggestion {
      id
      quantity
      proposer
      product {
        id
        title
        salesUnitSize
        priceV2 {
          now {
            amount
          }
          was {
            amount
          }
        }
      }
    }
    alternativeSections {
      title
      description
      productSuggestions {
        id
        quantity
        product {
          id
          title
        }
      }
    }
  }
}
```

`options` only takes `recipeId` (`servings` is rejected). `productSuggestion.product.id` is a webshop id ready for the basket. LIVE: 6 of 6 ingredients mapped (e.g. "300 g spaghetti" to 62028 AH Spaghetti, quantity 1).

MK's queries are out of date: `recipeSearch(query: {query, size})` fails ("Field "query" is not defined by type RecipeSearchParams", "Cannot query field "cookTime" on type RecipeSummary"), and its `recipe` selection uses non-existent `unit`, `steps`, `slug`. AG doc lists `FetchRecommendedRecipes` (`recipeRecommendationLane`, user-personalised) and the schema has `recipeAutoSuggestions`, `recipeSuggestionsForProductId`, `recipeBonusLane`, `recipeWeekPlannerOverview`, `recipeShoppedRecipes`, and mutations `recipeShoppableSaveSelectionV2`, `recipeUpdateWeekPlannerItems`, `recipeCollection*`.

---

## 10. Other endpoints seen (not in the capability list)

| Endpoint                                                                                                                                                                                                                                                           | Auth  | Source                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------- |
| `POST /mobile-services/v2/recommendations/crosssells` `{limit, experimentId, productId, propensityFilter, basketItems[{productId,position,quantity}]}`                                                                                                             | user? | AG doc                        |
| `POST /mobile-services/v2/recommendations/dontforgetlane` `{positiveCmOnly, offset, usecaseId:"app_mylist", basketItems[], limit}` → `{productCards[]}`                                                                                                            | user? | AG doc                        |
| `GET /mobile-services/config/v1/features/ios?version=9.28` (feature flags; dump in AG `doc/feature-flags-20260118.md`)                                                                                                                                             | anon? | AG doc                        |
| `GET /mobile-services/versioncheck/v3/ipad/9.28/check`                                                                                                                                                                                                             | anon? | AG doc                        |
| `GET /mobile-services/v2/webflow`                                                                                                                                                                                                                                  | ?     | AG doc                        |
| `POST /mobile-services/v3/analytics/bulk` (202)                                                                                                                                                                                                                    | ?     | AG doc                        |
| Purchase stamps (koopzegels): `GET /mobile-services/v1/purchase-stamps`, `/balance`, `/transactions`                                                                                                                                                               | user  | NB                            |
| Air Miles / loyalty stamps: `GET /mobile-services/stamps/v1/airmiles/balances`, `/stamps/v3/programs`, `POST /stamps/v1/transfer`                                                                                                                                  | user  | NB                            |
| AH to go: `GET /mobile-services/togo/v1/campaigns/balance`                                                                                                                                                                                                         | user  | NB                            |
| GraphQL `FetchEntryPoints` (`entryPointComponent(name:"my-ah-lane-nl", version)`), `FetchCuratedLists`, `FetchSmartLane`, `FetchNBACard`, `FetchPageTemplate`, `GetConsentsToShow`, `MessageCenterGetUnreadMessagesInfo`, `PushNotificationsTokenUpdate`           | mixed | AG doc (operation names only) |
| GraphQL `purchaseStampBalance`, `milesBalance`, `addressSearch`, `deliveryBundles` / `deliveryBundleSubscription`, `productAlternatives`, `productCrossSellsV2`, `productAutosuggest`, `productReturnOrders`, `productComplaint*`, `orderBudgetV2`, `orderSamples` | mixed | schema dump                   |

---

## 11. Live checks, 2026-10-28 (anonymous token only)

Token: `POST /mobile-auth/v1/auth/token/anonymous {"clientId":"appie"}`, headers from section 1. No login, no user endpoints.

| #   | Call                                                                | HTTP      | Result                                   |
| --- | ------------------------------------------------------------------- | --------- | ---------------------------------------- |
| 1   | anonymous token, `clientId: appie` and `appie-ios`                  | 200 / 200 | `expires_in: 604798`                     |
| 2   | refresh with anonymous refresh token (twice with the same one)      | 200 / 200 | new pair each time                       |
| 3   | code exchange with `code: "invalid"`                                | 400       | `Incorrect request send by client`       |
| 4   | REST search `query=halfvolle melk&size=3`                           | 200       | 66 hits                                  |
| 5   | REST search with `bonus=true`, `brand=AH`, `nutriscore=A`           | 200       | totals unchanged (filters ignored)       |
| 6   | REST search with `filters=...`                                      | 500       | IndexOutOfBoundsException                |
| 7   | REST search `taxonomyId=1730` (no query)                            | 200       | 2016 hits                                |
| 8   | REST search without `x-application`                                 | 500       | `Can not find application: 'null'`       |
| 9   | products by ids                                                     | 200       | array of 2                               |
| 10  | product detail v4/fir/33693                                         | 200       | card + tradeItem + properties            |
| 11  | GraphQL `product` nutrition                                         | 200       | 12 nutrients                             |
| 12  | GraphQL `searchProducts` with bonus + brand facets                  | 200       | 30 found, discount text present          |
| 13  | GTIN `/product/search/v1/gtin/8710400058519`                        | 200       | webshopId 33693                          |
| 14  | `/product-shelves/categories` and `/categories/1730/sub-categories` | 200 / 200 | 28 top-level, 8+ children                |
| 15  | bonus metadata v3                                                   | 200       | 1 period, 2 tabs                         |
| 16  | bonus section `category=Kaas`                                       | 200       | 7 groups, `products: []`                 |
| 17  | bonus spotlight                                                     | 200       | 5 groups                                 |
| 18  | GraphQL `bonusPromotions` group 821906                              | 200       | 11 products                              |
| 19  | GraphQL `bonusPeriods`, `totalPrice`                                | 200 / 200 | ok                                       |
| 20  | GraphQL `storesSearch` by postcode / by `location` / `storeTypes`   | 200       | ok                                       |
| 21  | GraphQL `storesInformation(id: 2225)`                               | 200       | ok                                       |
| 22  | GraphQL `bargainItems` (3 stores), `bargainCategories`              | 200       | `data: null`, "Subgraph errors redacted" |
| 23  | GraphQL `recipeSearchV2` (plain and with filter)                    | 200       | 182 hits for "pasta pesto"               |
| 24  | GraphQL `recipe(id)`                                                | 200       | full detail                              |
| 25  | GraphQL `recipeProductSuggestionsV2`                                | 200       | 6 mappings                               |
| 26  | MK `recipeSearch(query:{...})`                                      | 400       | validation failed                        |
| 27  | `login.ah.nl/login?...` curl UA / Chrome UA                         | 403 / 200 |                                          |

Trimmed samples:

```json
// 4. REST search product (non-bonus item)
{"page":{"size":3,"totalElements":66,"totalPages":22,"number":0},
 "products":[{"webshopId":33693,"hqId":92154,"title":"AH Halfvolle melk","salesUnitSize":"1,5 l",
   "unitPriceDescription":"prijs per liter €1.19","currentPrice":null,"priceBeforeBonus":1.79,
   "isBonus":false,"bonusMechanism":null,"nutriscore":"B","mainCategory":"Zuivel, eieren",
   "subCategory":"Halfvolle melk","availableOnline":true,"isOrderable":true,
   "orderAvailabilityStatus":"IN_ASSORTMENT","images":[{"width":800,"height":800,"url":"https://static.ah.nl/dam/product/AHI_...?rendition=800x800_WEBP"}]}]}
// 4. bonus item in the same response
{"webshopId":609672,"title":"Campina Langlekker halfvolle melk 3-pack","currentPrice":5.1,"priceBeforeBonus":5.37,
 "isBonus":true,"bonusMechanism":"5% volume voordeel","promotionType":"AHONLINE","bonusStartDate":"2026-10-28",
 "bonusEndDate":"2999-12-31","isVirtualBundle":true,"virtualBundleItems":[{"productId":469397,"quantity":3}],
 "discountLabels":[{"code":"DISCOUNT_BUNDLE_BULK","defaultDescription":"5% volume voordeel","percentage":5}]}
```

```json
// 10. product detail (trimmed)
{
  "productId": 33693,
  "productCard": {
    "webshopId": 33693,
    "title": "AH Halfvolle melk",
    "priceBeforeBonus": 1.79,
    "unitPriceDescription": "prijs per liter €1.19",
    "isBonus": false,
    "subCategoryId": 2390
  },
  "properties": {
    "nutriscore": ["B"],
    "sp_include_dieet_vegetarisch": ["Vegetarisch"],
    "sp_exclude_intolerance_geen_lactose": ["Geen lactose"]
  },
  "tradeItem": {
    "gtin": "08710400058519",
    "foodAndBeverageIngredientStatement": "Ingrediënten: halfvolle melk*. ... *Van weidemelk.",
    "allergenInformation": [
      {
        "items": [
          {
            "typeCode": { "value": "AM", "label": "Melk" },
            "levelOfContainmentCode": { "value": "CONTAINS", "label": "Bevat" }
          }
        ]
      }
    ],
    "nutritionalInformation": {
      "nutrientHeaders": [
        {
          "nutrientBasisQuantity": { "value": 100.0, "measurementUnitCode": { "value": "ml" } },
          "nutrientDetail": [
            {
              "nutrientTypeCode": { "value": "ENER-", "label": "Energie" },
              "quantityContained": [{ "value": 48.0, "measurementUnitCode": { "value": "kcal" } }]
            }
          ]
        }
      ]
    }
  }
}
```

```json
// 12. GraphQL searchProducts product
{
  "id": 2600,
  "title": "AH Goudse jong 48+ plakken",
  "brand": "AH",
  "category": "Kaas/Jonge kaas (plakken)",
  "salesUnitSize": "190 g",
  "icons": ["NUTRISCORE_D", "VEGETARIAN", "LOCALLY_PRODUCED", "AVAILABLE_IN_STORE"],
  "priceV2": {
    "now": { "amount": 2.95 },
    "was": { "amount": 2.95 },
    "discount": { "description": "2 voor 5.50", "promotionType": "NATIONAL", "segmentType": "AH" }
  },
  "availability": { "isOrderable": true }
}
```

```json
// 15. bonus metadata (trimmed)
{"periods":[{"bonusStartDate":"2026-10-26","bonusEndDate":"2026-11-01","nextPeriodVisibleFrom":"2026-10-30",
  "tabs":[{"description":"Alle Bonus","urlMetadataList":[
    {"description":"Kaas","bonusType":"NATIONAL","count":7,"url":"bonuspage/v2/section?application=AHWEBSHOP&date=2026-10-26&promotionType=NATIONAL&category=Kaas"},
    {"description":"Etos acties","bonusType":"ETOS","count":37,"url":"bonuspage/v2/section?application=AHWEBSHOP&date=2026-10-26&promotionType=ETOS"}]}]}]}
// 16. bonus section group
{"sectionType":"AH","sectionDescription":"Kaas","bonusGroupOrProducts":[{"bonusGroup":{"id":"821906","segmentId":821906,
  "segmentDescription":"Alle Eru","discountDescription":"2 + 1 GRATIS","category":"Kaas","promotionType":"NATIONAL",
  "bonusStartDate":"2026-10-26","bonusEndDate":"2026-11-01","exampleFromPrice":null,"exampleForPrice":null,"products":[],
  "discountLabels":[{"code":"DISCOUNT_X_PLUS_Y_FREE","defaultDescription":"2+1 gratis","count":2,"freeCount":1}],
  "storeOnlyPromotion":false,"isStapelBonus":false}}]}
// 18. bonus group products
{"data":{"bonusPromotions":[{"id":"821906","title":"Alle Eru","productCount":11,"products":[{"id":113356,"title":"Eru Kids",
  "salesUnitSize":"100 g","availability":{"isOrderable":true},
  "priceV2":{"now":{"amount":1.75},"was":{"amount":1.75},"promotionLabel":{"tiers":[{"mechanism":"X_PLUS_Y_FREE","description":"2+1 gratis"}]}}}]}]}}
```

```json
// 20. storesSearch filter {postalCode:"2628CD"}
{
  "data": {
    "storesSearch": {
      "pageInfo": { "hasNextPage": true },
      "result": [
        {
          "id": 2225,
          "name": "Delft Bastiaanpoort",
          "storeType": "REGULAR",
          "phone": "088-6592225",
          "distance": 1506,
          "address": {
            "street": "Bastiaanpoort",
            "houseNumber": "7",
            "houseNumberExtra": null,
            "postalCode": "2611MC",
            "city": "Delft",
            "countryCode": "NLD"
          },
          "geoLocation": { "latitude": 52.0094083, "longitude": 4.3645232 },
          "openingDays": [
            [{ "date": "2026-10-26", "openingHour": { "openFrom": "08:00", "openUntil": "22:00" } }],
            [{ "date": "2026-11-02", "openingHour": { "openFrom": "08:00", "openUntil": "22:00" } }]
          ],
          "services": [{ "code": "AED" }, { "code": "BLP" }, { "code": "FTS" }]
        }
      ]
    }
  }
}
```

```json
// 23-25. recipes
{"recipeSearchV2":{"page":{"total":182,"hasNextPage":true},"correctedSearchTerm":null,"result":[{"id":1064602,"title":"Pasta pesto",
  "time":{"cook":20},"images":[{"width":445,"height":297,"url":"https://static.ah.nl/static/recepten/img_056059_445x297_JPG.jpg"}],
  "flags":["LOW_CALORIES"],"nutriScore":null,"tags":[{"key":"keuken","value":"italiaans"}]}]}}
{"recipe":{"id":1064602,"title":"Pasta pesto","cookTime":20,"href":"/allerhande/recept/R-R1064602/pasta-pesto",
  "servings":{"number":4,"type":"personen","isChangeable":true},
  "ingredients":[{"id":4129,"text":"300 g spaghetti","quantity":300,"quantityUnit":{"singular":"g","plural":"g"},"name":{"singular":"spaghetti","plural":null},"servingsScale":75}],
  "preparation":{"steps":["Kook de spaghetti volgens de aanwijzingen op de verpakking beetgaar. ", "..."]},
  "nutritions":{"energy":{"value":480,"unit":"kcal"}}}}
{"recipeProductSuggestionsV2":[{"optional":false,
  "ingredient":{"id":4129,"name":"spaghetti","quantityFloat":300,"quantityUnit":"g","completeText":"300 g spaghetti"},
  "productSuggestion":{"id":62028,"quantity":1,"proposer":"A","product":{"id":62028,"title":"AH Spaghetti","salesUnitSize":"500 g","priceV2":{"now":{"amount":0.34},"was":{"amount":0.34}}}},
  "alternativeSections":[]}]}
```

```json
// 22. bargainItems with anonymous token
{
  "data": null,
  "errors": [{ "message": "Subgraph errors redacted", "path": ["bargainItems"] }],
  "extensions": {
    "valueCompletion": [{ "message": "Cannot return null for non-nullable type BargainItem", "path": [] }]
  }
}
```

---

## 12. Where the sources disagree

| Topic                     | Versions                                                                                                                                  | Use                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Main shopping list        | GraphQL `basket.itemsInList` + `basketItemsAdd/Update` (FX, Oct 2026) vs REST `/shoppinglist/v2/items` GET/PATCH (AG, MS, MK, NB)         | FX for products; v2 PATCH only for free-text notes, with `?orderBy=userInput&orderByParam=0` (FX, MK) |
| Basket list field         | `itemsInList` (FX) vs `products` (AG doc)                                                                                                 | FX (live-verified)                                                                                    |
| Personal bonus            | `/bonuspage/v1/personal?bonusStartDate=` (AG code, FX) vs `/v2/section/personal?date=` (AG doc, NB) vs `/v1/choose-and-activate` (NB)     | first                                                                                                 |
| Receipts                  | GraphQL `posReceipts*` (AG code, FX) vs REST `/v1/receipts`, `/v2/receipts/{id}` (AG doc, NB; MK reports 503)                             | GraphQL                                                                                               |
| Header names              | `x-client-name`/`x-client-version` (all code) vs `x-clientname`/`x-clientversion` + Apollo headers (AG doc capture)                       | code set; only `x-application` and Bearer are enforced                                                |
| Anonymous clientId        | `appie-ios` (AG, FX) vs `appie` (NB, task brief)                                                                                          | both work                                                                                             |
| REST sort values          | `PRICE_ASC/PRICE_DESC` (AG doc) vs `PRICEHIGHLOW/PRICELOWHIGH/...` (AG search-api.md, LIVE)                                               | LIVE list                                                                                             |
| GraphQL search bonus text | null for multi-buy (AG, Mar 2026) vs present (LIVE)                                                                                       | handle both                                                                                           |
| Nutri-Score on detail     | missing (FX) vs `properties.nutriscore` (LIVE)                                                                                            | `properties`                                                                                          |
| Store `openingDays`       | flat list (AG doc) vs list of weekly lists (LIVE)                                                                                         | LIVE                                                                                                  |
| Recipe queries            | `recipeSearchV2` / `recipe(id)` with `quantityUnit`, `preparation.steps` (AG doc, LIVE) vs `recipeSearch(query:{})`, `unit`, `steps` (MK) | AG/LIVE; MK's are dead                                                                                |
| Koopjes auth              | AG (CLI refuses without login), MS and FX all use a user token; LIVE anonymous fails                                                      | user token                                                                                            |

---

## 13. Delivery slots (anon, PROBE 28 October 2026)

```graphql
query Slots($address: MemberAddressInput!) {
  orderDeliverySlots(address: $address) {
    date
    dateFormatted
    isFullyBooked
    slots {
      startTime
      endTime
      isFullyBooked
      shiftCode
      deliveryLocationId
      nudgeType
      serviceCharge {
        price {
          amount
        }
        defaultPrice {
          amount
        }
      }
    }
  }
}
```

`address` needs `street`, `houseNumber` (Int), `postalCode`, `city` and `countryCode` (`NLD`); `houseNumberExtra` is optional. It returns 14 days. `date` is midnight Amsterdam time in UTC; `dateFormatted` is the local date. Slot times are UTC. Works with an anonymous token. `orderPickupSlots(pickupLocationId: Int!)` needs a pick-up point id.

Reserving a slot has no known call. Booking happens in the app; once an order exists, `basketItemsAdd` and `basketItemsUpdate` change it until its closing time.

## 14. Account checks, 29 October 2026 (new account, signed in)

Run with `npm run test:live:account` plus a one-off sweep of every account read tool, on an account created the same day.

- Sign-in: the headed Chrome window on `login.ah.nl` was not refused by its bot protection, and the `appie://login-exit` code exchanged for tokens. Headless Chrome is still refused (section 2).
- Worked: member profile (`member`), basket and list read, list product add and remove plus a free-text note through the v2 PATCH (6.2), the preview and confirm pair on the list while nothing is booked, favourite lists read, add and remove (6.3), personal bonus, orders list, receipts list, `get_last_chance` with a user token, and delivery slots for the account's own address.
- Empty on a new account, so only the empty shape is checked: orders, receipts, frequent products, spending. Not reachable without history or a booking: order details, receipt details, and a preview against a booked order.
