const { encode } = require('@toon-format/toon');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');

// Load and buffer HTML template
const HTML_TEMPLATE_PATH = path.join(__dirname, 'html_template.html');
let HTML_TEMPLATE_CACHE = null;

function loadHtmlTemplate() {
  if (!HTML_TEMPLATE_CACHE) {
    HTML_TEMPLATE_CACHE = fs.readFileSync(HTML_TEMPLATE_PATH, 'utf8');
  }
  return HTML_TEMPLATE_CACHE;
}

const FORMAT_TYPES = Object.freeze({
  JSON: 'json',
  TOON: 'toon',
  TEXT: 'text',
  CSV: 'csv',
  HTML: 'html',
});

const FORMAT_ALIASES = Object.freeze({
  json: FORMAT_TYPES.JSON,
  toon: FORMAT_TYPES.TOON,
  txt: FORMAT_TYPES.TEXT,
  text: FORMAT_TYPES.TEXT,
  csv: FORMAT_TYPES.CSV,
  html: FORMAT_TYPES.HTML,
});

function normalizeFormat(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  return FORMAT_ALIASES[normalized] || null;
}

function resolveRequestedFormat(routeOverride, paramFormat) {
  return routeOverride || normalizeFormat(paramFormat) || FORMAT_TYPES.JSON;
}

function normalizeBulkResponse(rawResponse) {
  const rows = [];
  const meta = {};

  if (!rawResponse || typeof rawResponse !== 'object') {
    return { rows, meta };
  }

  for (const [key, value] of Object.entries(rawResponse)) {
    const entryIsLookup =
      value &&
      typeof value === 'object' &&
      (Object.prototype.hasOwnProperty.call(value, 'ip') ||
        Object.prototype.hasOwnProperty.call(value, 'asn'));

    if (entryIsLookup) {
      rows.push({
        query: key,
        ...value,
      });
    } else {
      meta[key] = value;
    }
  }

  return { rows, meta };
}

function serializePrimitive(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function objectToText(obj, indentLevel = 0) {
  if (obj === null || obj === undefined) {
    return `${'  '.repeat(indentLevel)}${serializePrimitive(obj)}`;
  }

  if (Array.isArray(obj)) {
    const indent = '  '.repeat(indentLevel);
    return obj
      .map((item, index) => `${indent}- [${index}]: ${serializePrimitive(item)}`)
      .join('\n');
  }

  if (typeof obj !== 'object') {
    return `${'  '.repeat(indentLevel)}${serializePrimitive(obj)}`;
  }

  const indent = '  '.repeat(indentLevel);
  const lines = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`);
      lines.push(objectToText(value, indentLevel + 1));
    } else {
      lines.push(`${indent}${key}: ${serializePrimitive(value)}`);
    }
  }

  return lines.join('\n');
}

function renderText(rows, meta, isBulkResponse) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const sections = [];

  if (isBulkResponse) {
    rows.forEach((row, index) => {
      const label = row.query || row.ip || `lookup_${index + 1}`;
      sections.push(`Lookup ${index + 1} (${label})\n${objectToText(row)}`);
    });
  } else {
    sections.push(objectToText(rows[0]));
  }

  if (meta && Object.keys(meta).length > 0) {
    sections.push(`Meta\n${objectToText(meta)}`);
  }

  return sections.join('\n\n');
}

function flattenRecord(record) {
  const result = {};

  const walk = (value, path) => {
    const currentPath = path || '';
    const isObject = value && typeof value === 'object' && !Array.isArray(value);

    if (isObject) {
      const entries = Object.entries(value);
      if (entries.length === 0 && currentPath) {
        result[currentPath] = '{}';
      }
      entries.forEach(([key, childValue]) => {
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        walk(childValue, nextPath);
      });
      return;
    }

    if (Array.isArray(value)) {
      result[currentPath] = value.length ? JSON.stringify(value) : '[]';
      return;
    }

    if (currentPath) {
      result[currentPath] = serializePrimitive(value);
    }
  };

  walk(record, '');
  return result;
}

function renderCsv(rows, meta) {
  const flattenedRows = (rows || []).map((row) => flattenRecord(row));

  if (meta && Object.keys(meta).length > 0) {
    flattenedRows.push(flattenRecord({ query: '__meta', ...meta }));
  }

  const fieldSet = new Set();
  flattenedRows.forEach((row) => {
    Object.keys(row).forEach((field) => fieldSet.add(field));
  });

  const fields = Array.from(fieldSet);
  if (fields.length === 0) {
    return '';
  }

  const parser = new Parser({ fields });
  return parser.parse(flattenedRows);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPropertyDescription(key, objectName = null) {
  // Extract first paragraph from showModal descriptions
  const descriptions = {
    'ip': 'The field contains the IP address that was queried.',
    'rir': 'The field specifies the Regional Internet Registry (RIR) that is authoritative for the queried IP address.',
    'is_bogon': 'The field determines if the queried IP address is bogon. Bogon IP addresses are not routable and thus not a part of the public Internet.',
    'is_mobile': 'The field determines if the queried IP address belongs to a mobile Internet Service Provider such as AT&T Wireless or T-Mobile.',
    'is_satellite': 'The field determines if the queried IP address belongs to a satellite Internet Service Provider such as Starlink, Viasat or OneWeb.',
    'is_crawler': 'The field determines if the IP address is associated with a crawler (Good Bot).',
    'is_datacenter': 'The field specifies whether the IP address belongs to a datacenter (hosting provider) or not.',
    'is_tor': 'If the field is true, the IP address is a TOR exit node.',
    'is_proxy': 'The field determines whether the IP address is a proxy server.',
    'is_vpn': 'The field determines whether the IP address is a VPN Exit Node and has datatype boolean.',
    'is_abuser': 'The field is true, if the IP address committed abusive actions.',
    'elapsed_ms': 'The field provides the amount of time in milliseconds (ms) the API took to process the API query.',
    'asn': 'The field is a unique identifier assigned to each autonomous system (AS) on the Internet.',
    'route': 'The IP route (prefix) in CIDR network format for the queried IP address.',
    'descr': 'An informational description for the AS.',
    'country': 'The origin country of the AS (administratively) as taken from the WHOIS record.',
    'active': 'Whether the AS is active. Active means that there is at least one route administered by the AS.',
    'org': 'The organization (Based on WHOIS data) responsible for this AS.',
    'domain': 'The domain of the organization to which this AS belongs.',
    'abuse': 'The email address to which abuse complaints for this organization should be sent (Based on WHOIS data).',
    'type': 'The type field, which can be hosting, education, government, banking, business or isp.',
    'type.asn': 'The type for this ASN, this is either hosting, education, government, banking, business or isp.',
    'type.company': 'The type for this organization (company), this is either hosting, education, government, banking, business or isp.',
    'created': 'When the ASN was first created (Based on WHOIS data).',
    'updated': 'The last time the ASN was updated (Based on WHOIS data).',
    'whois': 'An url to the raw WHOIS record.',
    'whois.asn': 'An url to the raw WHOIS record for the ASN.',
    'whois.company': 'An url to the raw WHOIS record for this IP address.',
    'name': 'The name field.',
    'name.company': 'The name of the organization (company). The name is obtained from the corresponding WHOIS record.',
    'name.abuse': 'The abuse contact name.',
    'network': 'The network for which the organization (company) has ownership.',
    'abuser_score': 'The field represents the quota of abusive IP addresses. The higher this number is, the more abusive the whole network is.',
    'latitude': 'The geographical latitude for the queried IP address.',
    'longitude': 'The geographical longitude for the queried IP address.',
    'city': 'The city to which the IP address belongs geographically.',
    'state': 'The state / administrative area of the queried IP address.',
    'country_code': 'The ISO 3166-1 alpha-2 country code to which the IP address belongs.',
    'zip': 'The zip code for the queried IP address.',
    'timezone': 'The timezone of the queried IP address.',
    'continent': 'The continent as two letter code such as NA for North America or EU for Europe.',
    'is_eu_member': 'The field is a boolean value that indicates whether the queried IP address is located in an EU member country.',
    'calling_code': 'The field contains the calling code for the country of the queried IP address.',
    'currency_code': 'The field contains the currency code for the country of the queried IP address.',
    'local_time': 'The local time for the queried IP in human readable format.',
    'local_time_unix': 'The local time for the queried IP as unix timestamp.',
    'is_dst': 'Whether daylight saving time (DST) is active in the geographical region for the queried IP address.',
    'address': 'The abuse contact address.',
    'phone': 'The abuse contact phone number.',
    'email': 'The abuse contact email.',
    'prefixes': 'The array contains all the IPv4 networks assigned to this ASN. This is an array of IPv4 networks in CIDR format.',
    'prefixesIPv6': 'The array contains all the IPv6 networks assigned to this ASN. This is an array of IPv6 networks in CIDR format.',
  };

  // Try object-specific key first, then generic key
  const fullKey = objectName ? `${key}.${objectName}` : key;
  return descriptions[fullKey] || descriptions[key] || `The ${key} field.`;
}

function getTypeTagClass(type) {
  const typeColors = {
    'hosting': 'is-info',
    'education': 'is-primary',
    'government': 'is-warning',
    'banking': 'is-success',
    'business': 'is-light',
    'isp': 'is-link',
  };
  return typeColors[type] || 'is-light';
}

function getCountryFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) {
    return '';
  }
  // Convert country code to flag emoji
  // Each letter is converted to regional indicator symbol
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function extractFirstIpFromCidr(cidr) {
  if (!cidr || typeof cidr !== 'string') {
    return null;
  }
  // Extract IP from CIDR notation (e.g., "192.168.1.0/24" -> "192.168.1.0")
  const parts = cidr.split('/');
  return parts[0] || null;
}

function renderHtmlValue(value, key = null, objectName = null) {
  // Handle boolean values FIRST with Font Awesome icons and text
  if (typeof value === 'boolean') {
    const iconClass = value ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
    const text = value ? 'true' : 'false';
    return `<span class="boolean-value"><i class="${iconClass}"></i> ${text}</span>`;
  }

  if (Array.isArray(value)) {
    // Handle prefixes arrays - make each prefix a link
    if (key === 'prefixes' || key === 'prefixesIPv6') {
      const items = value.map((item) => {
        const firstIp = extractFirstIpFromCidr(item);
        if (firstIp) {
          const ipEscaped = escapeHtml(item);
          return `<li><a href="?q=${encodeURIComponent(firstIp)}" class="prefix-link" data-ip="${escapeHtml(firstIp)}">${ipEscaped}</a></li>`;
        }
        return `<li>${escapeHtml(item)}</li>`;
      }).join('');
      return `<ul>${items}</ul>`;
    }
    const items = value.map((item) => `<li>${renderHtmlValue(item, null, objectName)}</li>`).join('');
    return `<ul>${items}</ul>`;
  }

  if (value && typeof value === 'object') {
    return renderHtmlSection(value, objectName);
  }

  const escaped = escapeHtml(serializePrimitive(value));

  // Handle IP field - make it a link to itself
  if (key === 'ip' && escaped && escaped !== 'null' && escaped !== '') {
    return `<a href="?q=${encodeURIComponent(escaped)}" class="ip-link" data-ip="${escapeHtml(escaped)}">${escaped}</a>`;
  }

  // Handle ASN field - make it a link to ASN HTML page
  if (key === 'asn' && escaped && escaped !== 'null' && escaped !== '') {
    const asnValue = String(value);
    return `<a href="?q=${encodeURIComponent('as' + asnValue)}" class="asn-link" data-asn="${escapeHtml(asnValue)}">${escaped}</a>`;
  }

  // Handle whois fields as links
  if (key === 'whois' && escaped && escaped !== 'null' && escaped !== '' && escaped.startsWith('http')) {
    return `<a href="${escaped}" target="_blank" rel="noopener noreferrer">${escaped} <i class="fas fa-external-link-alt"></i></a>`;
  }

  // Handle type fields with colorful tags
  if (key === 'type' && escaped && escaped !== 'null' && escaped !== '') {
    const tagClass = getTypeTagClass(escaped.toLowerCase());
    return `<span class="tag ${tagClass}">${escaped}</span>`;
  }

  return `<span>${escaped}</span>`;
}

function renderHtmlSection(obj, objectName = null) {
  const securityFlags = ['is_proxy', 'is_vpn', 'is_abuser', 'is_tor', 'is_datacenter', 'is_crawler', 'is_bogon', 'is_mobile', 'is_satellite'];

  const rows = Object.entries(obj || {})
    .filter(([key, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) => {
        const isSecurityFlag = securityFlags.includes(key);
        const isTrueSecurityFlag = isSecurityFlag && value === true;
        const valueClass = isTrueSecurityFlag ? 'security-flag-value' : '';
        const description = getPropertyDescription(key, objectName);
        const tooltipId = `tooltip-${objectName || 'root'}-${key}`;
        const modalId = `modal-${tooltipId}`;

        return `
          <tr>
            <td class="has-text-weight-semibold">
              <span class="label-with-tooltip">
                ${escapeHtml(key)}
                <div class="tooltip-container">
                  <i class="fas fa-circle-info tooltip-icon"></i>
                  <span>${escapeHtml(description)}</span>
                </div>
              </span>
            </td>
            <td class="${valueClass}">${renderHtmlValue(value, key, objectName)}</td>
          </tr>
        `;
      },
    );

  if (rows.length === 0) {
    return '';
  }

  return `<table class="table is-fullwidth"><tbody>${rows.join('')}</tbody></table>`;
}

function renderHtml(rows, meta, isBulkResponse) {
  if (isBulkResponse || rows.length === 0) {
    // For bulk responses, use simpler layout
    const cards = [];
    rows.forEach((row, index) => {
      const label = row.query || row.ip || row.asn || `lookup_${index + 1}`;
      cards.push(`
        <div class="box">
          <h2 class="title is-4">Lookup ${index + 1}: ${escapeHtml(label)}</h2>
          ${renderHtmlSection(row)}
        </div>
      `);
    });
    return generateHtmlTemplate('Bulk Lookup Results', [], cards.join('\n'), '');
  }

  const row = rows[0];
  // Check if this is an ASN lookup (has asn but no ip)
  const isAsnLookup = row.asn && !row.ip;

  // Build page title with location info
  let pageTitleText = ''; // For <title> tag (text only)
  let pageTitleHtml = ''; // For header display (with HTML tags)

  if (isAsnLookup) {
    // For ASN lookups: AS{number} - ORG name - Country - Flag
    const asnNumber = String(row.asn);
    const asnPrefix = `AS${asnNumber}`;
    pageTitleText = asnPrefix;
    pageTitleHtml = asnPrefix;

    const asnParts = [];
    if (row.org) {
      asnParts.push(row.org);
    }
    if (row.country) {
      asnParts.push(row.country);
    }
    if (row.country) {
      const flagEmoji = getCountryFlagEmoji(row.country);
      if (flagEmoji) {
        asnParts.push(flagEmoji);
      }
    }

    if (asnParts.length > 0) {
      const asnInfoStr = asnParts.join(' - ');
      pageTitleText += ` - ${asnInfoStr}`;
      pageTitleHtml += ` - ${asnInfoStr}`;
    }
  } else {
    // For IP lookups
    const identifier = String(row.ip || 'Unknown');
    pageTitleText = identifier;
    pageTitleHtml = identifier;

    if (row.location) {
      const locationParts = [];
      if (row.location.city) locationParts.push(row.location.city);
      if (row.location.state) locationParts.push(row.location.state);
      if (row.location.country) locationParts.push(row.location.country);

      let flagEmoji = '';
      if (row.location.country_code) {
        flagEmoji = getCountryFlagEmoji(row.location.country_code);
      }

      if (locationParts.length > 0) {
        const locationStr = locationParts.join(', ') + (flagEmoji ? ` ${flagEmoji}` : '');
        pageTitleText += ` - ${locationStr}`;
        pageTitleHtml += ` - ${locationStr}`;
      }
    }
  }

  // Add tags for datacenter, vpn, proxy, abuser (for header display - separate row)
  const titleTags = [];
  if (row.is_datacenter) {
    titleTags.push('<span class="tag is-info is-small">Datacenter</span>');
  }
  if (row.is_vpn) {
    titleTags.push('<span class="tag is-danger is-small">VPN</span>');
  }
  if (row.is_proxy) {
    titleTags.push('<span class="tag is-warning is-small">Proxy</span>');
  }
  if (row.is_abuser) {
    titleTags.push('<span class="tag is-danger is-small">Abuser</span>');
  }

  const headerTagsHtml = titleTags.length > 0 ? `<div class="header-tags-row">${titleTags.join(' ')}</div>` : '';

  const pageTitle = pageTitleHtml;

  // Organize data into sections
  const sections = [];
  const menuItems = [];

  // For ASN lookups, show ASN section first, otherwise show Overview
  if (isAsnLookup) {
    // ASN section for ASN lookups (include abuse as a normal field)
    if (row.asn || row.abuser_score || row.descr || row.country || row.active || row.org || row.domain || row.type || row.created || row.updated || row.rir || row.whois || row.prefixes || row.abuse) {
      menuItems.push({ id: 'asn', label: 'ASN' });
      const asnData = {
        asn: row.asn,
        abuser_score: row.abuser_score,
        descr: row.descr,
        country: row.country,
        active: row.active,
        org: row.org,
        domain: row.domain,
        type: row.type,
        created: row.created,
        updated: row.updated,
        rir: row.rir,
        whois: row.whois,
        abuse: row.abuse,
        prefixes: row.prefixes,
        prefixesIPv6: row.prefixesIPv6,
        elapsed_ms: row.elapsed_ms,
      };
      sections.push({
        id: 'asn',
        title: 'ASN',
        content: renderHtmlSection(asnData, 'asn'),
      });
    }
  } else {
    // Overview section for IP lookups
    const overviewData = {
      ip: row.ip,
      rir: row.rir,
      is_bogon: row.is_bogon,
      is_mobile: row.is_mobile,
      is_satellite: row.is_satellite,
      is_crawler: row.is_crawler,
      is_datacenter: row.is_datacenter,
      is_tor: row.is_tor,
      is_proxy: row.is_proxy,
      is_vpn: row.is_vpn,
      is_abuser: row.is_abuser,
      elapsed_ms: row.elapsed_ms,
    };
    if (Object.values(overviewData).some(v => v !== undefined && v !== null)) {
      menuItems.push({ id: 'overview', label: 'Overview' });
      sections.push({
        id: 'overview',
        title: 'Overview',
        content: renderHtmlSection(overviewData),
      });
    }
  }

  // Location section
  if (row.location) {
    menuItems.push({ id: 'location', label: 'Location' });
    const mapSection = buildMapSection(row);
    sections.push({
      id: 'location',
      title: 'Location',
      content: mapSection + renderHtmlSection(row.location, 'location'),
    });
  }

  // ASN section (only for IP lookups, not ASN lookups)
  if (row.asn && !isAsnLookup) {
    menuItems.push({ id: 'asn', label: 'ASN' });
    sections.push({
      id: 'asn',
      title: 'ASN',
      content: renderHtmlSection(row.asn, 'asn'),
    });
  }

  // Company section
  if (row.company) {
    menuItems.push({ id: 'company', label: 'Company' });
    sections.push({
      id: 'company',
      title: 'Company',
      content: renderHtmlSection(row.company, 'company'),
    });
  }

  // Datacenter section
  if (row.datacenter) {
    menuItems.push({ id: 'datacenter', label: 'Datacenter' });
    sections.push({
      id: 'datacenter',
      title: 'Datacenter',
      content: renderHtmlSection(row.datacenter),
    });
  }

  // Abuse section (only for IP lookups, not ASN lookups)
  if (row.abuse && !isAsnLookup) {
    menuItems.push({ id: 'abuse', label: 'Abuse Contact' });
    sections.push({
      id: 'abuse',
      title: 'Abuse Contact',
      content: renderHtmlSection(row.abuse),
    });
  }

  // VPN section
  if (row.vpn) {
    menuItems.push({ id: 'vpn', label: 'VPN' });
    sections.push({
      id: 'vpn',
      title: 'VPN',
      content: renderHtmlSection(row.vpn),
    });
  }

  // Meta section
  if (meta && Object.keys(meta).length > 0) {
    menuItems.push({ id: 'meta', label: 'Meta' });
    sections.push({
      id: 'meta',
      title: 'Meta',
      content: renderHtmlSection(meta),
    });
  }

  const sectionsHtml = sections.map(
    (section) => `
      <section id="${section.id}" class="content-section">
        <h2 class="title is-4">${escapeHtml(section.title)}</h2>
        ${section.content}
      </section>
    `,
  ).join('\n');

  return generateHtmlTemplate(pageTitle, menuItems, sectionsHtml, headerTagsHtml);
}

function buildMapSection(row) {
  const latitude = Number(row?.location?.latitude ?? row?.location?.lat);
  const longitude = Number(row?.location?.longitude ?? row?.location?.lon ?? row?.location?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return '';
  }
  const delta = 0.08;
  const bbox = [
    longitude - delta,
    latitude - delta,
    longitude + delta,
    latitude + delta,
  ]
    .map((coord) => coord.toFixed(6))
    .join(',');
  const marker = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(marker)}`;
  const mapLink = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(latitude.toFixed(6))}&mlon=${encodeURIComponent(longitude.toFixed(6))}#map=11/${encodeURIComponent(latitude.toFixed(6))}/${encodeURIComponent(longitude.toFixed(6))}`;
  return `
    <div class="map-wrapper">
      <iframe
        title="IP location"
        src="${mapUrl}"
        loading="lazy"
        referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups"
      ></iframe>
      <a class="map-link" href="${mapLink}" target="_blank" rel="noopener noreferrer">View on OpenStreetMap ↗</a>
    </div>
  `;
}

function generateHtmlTemplate(pageTitle, menuItems, content, headerTagsHtml = '') {
  const sidebarHtml = menuItems.length > 0
    ? `
      <aside class="menu sidebar">
        <p class="menu-label">Navigation</p>
        <ul class="menu-list">
          ${menuItems.map((item, index) => `
            <li>
              <a href="#${item.id}" class="menu-item ${index === 0 ? 'is-active' : ''}" data-section="${item.id}">
                ${escapeHtml(item.label)}
              </a>
            </li>
          `).join('')}
        </ul>
      </aside>
    `
    : '';

  // Load template and replace placeholders
  let template = loadHtmlTemplate();
  // Extract text for <title> tag (no HTML), use HTML for header
  // Ensure pageTitle is a string
  const pageTitleStr = String(pageTitle || '');
  const titleText = pageTitleStr.replace(/<[^>]*>/g, ''); // Strip HTML tags for <title>
  template = template.replace('{{PAGE_TITLE}}', escapeHtml(titleText));
  template = template.replace('{{HEADER_TITLE}}', pageTitleStr); // HTML version for header
  template = template.replace('{{HEADER_TAGS}}', headerTagsHtml || '');
  template = template.replace('{{SIDEBAR}}', sidebarHtml);
  template = template.replace('{{CONTENT}}', content);

  return template;
}

function formatResponsePayload(apiResponse, format, options = {}) {
  if (format === FORMAT_TYPES.JSON) {
    return {
      isJson: true,
      body: apiResponse,
    };
  }

  const bulkPayload = options.isBulk ? normalizeBulkResponse(apiResponse) : null;
  const rows = options.isBulk ? bulkPayload.rows : [apiResponse];
  const meta = options.isBulk ? bulkPayload.meta : null;

  switch (format) {
    case FORMAT_TYPES.TOON: {
      const toonInput = options.isBulk
        ? {
          lookups: bulkPayload.rows,
          meta: bulkPayload.meta,
        }
        : apiResponse;
      return {
        isJson: false,
        contentType: 'text/plain; charset=utf-8',
        body: encode(toonInput),
      };
    }
    case FORMAT_TYPES.TEXT:
      return {
        isJson: false,
        contentType: 'text/plain; charset=utf-8',
        body: renderText(rows, meta, options.isBulk),
      };
    case FORMAT_TYPES.CSV:
      return {
        isJson: false,
        contentType: 'text/csv; charset=utf-8',
        body: renderCsv(rows, meta),
      };
    case FORMAT_TYPES.HTML:
      return {
        isJson: false,
        contentType: 'text/html; charset=utf-8',
        body: renderHtml(rows, meta, options.isBulk),
      };
    default:
      return {
        isJson: true,
        body: apiResponse,
      };
  }
}

module.exports = {
  FORMAT_TYPES,
  resolveRequestedFormat,
  formatResponsePayload,
};

