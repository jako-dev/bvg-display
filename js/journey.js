/**
 * Journey Rendering
 *
 * Turns `/journeys` results into the connection list: when to leave, which
 * line to board, where to change, and how long it all takes. Fetching and
 * state live in app.js — this module only formats and draws.
 */
const JourneyView = (() => {
    'use strict';

    const DELAY_THRESHOLD_SEC = 60;

    const PRODUCT_LABELS = {
        suburban: 'S-Bahn', subway: 'U-Bahn', tram: 'Tram',
        bus: 'Bus', ferry: 'Fähre', express: 'IC/ICE', regional: 'Regional'
    };

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = (str) => (str === null || str === undefined)
        ? ''
        : String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

    const parseTime = (raw) => {
        if (!raw) return null;
        const date = new Date(raw);
        return isNaN(date) ? null : date;
    };

    const clockTime = (raw) => {
        const date = parseTime(raw);
        return date ? date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '--:--';
    };

    /** Minutes from now, floored at 0 — "in 3 min" reads better than "in -0 min". */
    function minutesUntil(raw) {
        const date = parseTime(raw);
        if (!date) return null;
        return Math.max(0, Math.round((date - Date.now()) / 60000));
    }

    function durationMinutes(journey) {
        const legs = journey.legs || [];
        if (legs.length === 0) return null;
        const start = parseTime(legs[0].departure || legs[0].plannedDeparture);
        const end = parseTime(legs[legs.length - 1].arrival || legs[legs.length - 1].plannedArrival);
        if (!start || !end) return null;
        return Math.max(0, Math.round((end - start) / 60000));
    }

    const formatDuration = (minutes) => {
        if (minutes === null) return '--';
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
    };

    /** Legs that are actually ridden — walking legs aren't "changes". */
    const ridingLegs = (journey) => (journey.legs || []).filter(leg => !leg.walking && leg.line);

    const transferCount = (journey) => Math.max(0, ridingLegs(journey).length - 1);

    function journeyDeparture(journey) {
        const legs = journey.legs || [];
        return legs.length ? (legs[0].departure || legs[0].plannedDeparture) : null;
    }

    function journeyArrival(journey) {
        const legs = journey.legs || [];
        return legs.length ? (legs[legs.length - 1].arrival || legs[legs.length - 1].plannedArrival) : null;
    }

    /** A journey is only as punctual as its worst leg. */
    function worstDelay(journey) {
        let worst = 0;
        for (const leg of journey.legs || []) {
            if (typeof leg.departureDelay === 'number') worst = Math.max(worst, leg.departureDelay);
            if (typeof leg.arrivalDelay === 'number') worst = Math.max(worst, leg.arrivalDelay);
        }
        return worst;
    }

    const isCancelled = (journey) => (journey.legs || []).some(leg => leg.cancelled === true);

    function legBadgeHtml(leg) {
        if (leg.walking) {
            const distance = leg.distance ? ` ${Math.round(leg.distance)} m` : '';
            return `<span class="leg-chip leg-walk" title="Fußweg${distance}">
                        <span class="leg-walk-icon" aria-hidden="true">&#128694;</span>
                        <span class="leg-walk-text">${leg.distance ? Math.round(leg.distance) + ' m' : 'Fußweg'}</span>
                    </span>`;
        }
        const line = leg.line || {};
        const product = line.product || '';
        return `<span class="leg-chip leg-line ${escapeHtml(product)}" title="${escapeHtml(PRODUCT_LABELS[product] || product)}">
                    ${escapeHtml(line.name || '?')}
                </span>`;
    }

    /** The line badges with arrows between them — the at-a-glance "how". */
    function legStripHtml(journey) {
        const legs = journey.legs || [];
        if (legs.length === 0) return '';
        return legs
            .map(legBadgeHtml)
            .join('<span class="leg-arrow" aria-hidden="true">›</span>');
    }

    function legDetailHtml(leg) {
        if (leg.walking) {
            const distance = leg.distance ? `${Math.round(leg.distance)} m` : '';
            return `
                <li class="journey-leg journey-leg-walk">
                    <span class="leg-time">${clockTime(leg.departure)}</span>
                    <span class="leg-body">
                        <span class="leg-title">Fußweg ${escapeHtml(distance)}</span>
                        <span class="leg-sub">${escapeHtml(leg.origin && leg.origin.name || '')} &rarr; ${escapeHtml(leg.destination && leg.destination.name || '')}</span>
                    </span>
                </li>`;
        }

        const line = leg.line || {};
        const platform = leg.departurePlatform || leg.plannedDeparturePlatform;
        const delay = typeof leg.departureDelay === 'number' ? leg.departureDelay : 0;
        const delayHtml = delay > DELAY_THRESHOLD_SEC
            ? `<span class="leg-delay">+${Math.round(delay / 60)}</span>`
            : '';

        return `
            <li class="journey-leg${leg.cancelled ? ' is-cancelled' : ''}">
                <span class="leg-time">${clockTime(leg.departure || leg.plannedDeparture)}${delayHtml}</span>
                <span class="leg-body">
                    <span class="leg-title">
                        ${legBadgeHtml(leg)}
                        <span class="leg-direction">${escapeHtml(leg.direction || (leg.destination && leg.destination.name) || '')}</span>
                    </span>
                    <span class="leg-sub">
                        ab ${escapeHtml(leg.origin && leg.origin.name || '')}${platform ? ` &middot; Gl. ${escapeHtml(platform)}` : ''}
                        &middot; an ${clockTime(leg.arrival || leg.plannedArrival)} ${escapeHtml(leg.destination && leg.destination.name || '')}
                    </span>
                </span>
            </li>`;
    }

    function journeyCardHtml(journey, index, selectedIndex) {
        const departure = journeyDeparture(journey);
        const arrival = journeyArrival(journey);
        const minutes = minutesUntil(departure);
        const delay = worstDelay(journey);
        const cancelled = isCancelled(journey);
        const transfers = transferCount(journey);

        let statusClass = '';
        if (cancelled) statusClass = ' is-cancelled';
        else if (delay > DELAY_THRESHOLD_SEC) statusClass = ' is-delayed';

        const leaveIn = cancelled
            ? '<span class="journey-cancelled">Fällt aus</span>'
            : (minutes === 0 ? 'jetzt' : `in ${minutes} min`);

        return `
            <article class="journey-card${statusClass}${index === selectedIndex ? ' is-selected' : ''}"
                     data-index="${index}" tabindex="0" role="button"
                     aria-pressed="${index === selectedIndex ? 'true' : 'false'}">
                <header class="journey-card-head">
                    <span class="journey-leave">${leaveIn}</span>
                    <span class="journey-window">
                        ${clockTime(departure)} &ndash; ${clockTime(arrival)}
                        ${delay > DELAY_THRESHOLD_SEC ? `<span class="journey-delay">+${Math.round(delay / 60)} min</span>` : ''}
                    </span>
                    <span class="journey-meta">
                        ${formatDuration(durationMinutes(journey))}
                        &middot; ${transfers === 0 ? 'direkt' : transfers === 1 ? '1 Umstieg' : `${transfers} Umstiege`}
                    </span>
                </header>
                <div class="journey-strip">${legStripHtml(journey)}</div>
                <ul class="journey-legs">${(journey.legs || []).map(legDetailHtml).join('')}</ul>
            </article>`;
    }

    /**
     * Draw the connection list.
     * @param {HTMLElement} container
     * @param {Array} journeys
     * @param {Object} [opt]
     * @param {number} [opt.selectedIndex] - Card to mark as shown on the map
     */
    function render(container, journeys, opt = {}) {
        if (!container) return;
        if (!Array.isArray(journeys) || journeys.length === 0) {
            container.innerHTML = '<div class="journey-empty"><p>Keine Verbindungen gefunden.</p></div>';
            return;
        }
        const selectedIndex = typeof opt.selectedIndex === 'number' ? opt.selectedIndex : -1;
        container.innerHTML = journeys.map((journey, i) => journeyCardHtml(journey, i, selectedIndex)).join('');
    }

    /**
     * Every leg of a journey as map-ready geometry.
     * @returns {Array<{points: Array<[number, number]>, product: string, dashed: boolean, label: string}>}
     */
    function toRoutes(journey) {
        const routes = [];
        for (const leg of journey.legs || []) {
            const points = BvgApi.polylineToLatLngs(leg.polyline);
            if (points.length < 2) continue;
            routes.push({
                points,
                product: leg.walking ? 'walking' : ((leg.line && leg.line.product) || ''),
                dashed: !!leg.walking,
                label: leg.walking ? 'Fußweg' : ((leg.line && leg.line.name) || '')
            });
        }
        return routes;
    }

    /** Origin, destination and every transfer point, for map markers. */
    function toStops(journey) {
        const legs = journey.legs || [];
        const stops = [];
        const seen = new Set();

        const push = (stop, kind) => {
            const loc = stop && stop.location;
            if (!loc || !isFinite(loc.latitude) || !isFinite(loc.longitude)) return;
            const key = `${loc.latitude},${loc.longitude}`;
            if (seen.has(key)) return;
            seen.add(key);
            stops.push({ lat: loc.latitude, lng: loc.longitude, name: stop.name || '', kind });
        };

        legs.forEach((leg, i) => {
            push(leg.origin, i === 0 ? 'origin' : 'stop');
            push(leg.destination, i === legs.length - 1 ? 'destination' : 'stop');
        });
        return stops;
    }

    return {
        render,
        toRoutes,
        toStops,
        durationMinutes,
        transferCount,
        journeyDeparture,
        formatDuration
    };
})();
