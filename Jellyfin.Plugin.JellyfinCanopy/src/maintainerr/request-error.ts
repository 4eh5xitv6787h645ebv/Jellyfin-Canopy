import type { HttpError } from '../types/jc';

export type MaintainerrErrorText = (key: string, fallback: string) => string;

/**
 * Convert only Canopy's reviewed Maintainerr error codes into localized,
 * operator-readable text. Arbitrary exception and upstream response strings
 * are deliberately ignored so private URLs and implementation details cannot
 * reach the UI.
 */
export function describeMaintainerrRequestError(
    error: unknown,
    fallback: string,
    text: MaintainerrErrorText,
): string {
    const body = (error as HttpError | undefined)?.responseJSON;
    const code = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { error?: unknown }).error
        : undefined;
    switch (code) {
        case 'invalid_configuration':
        case 'invalid_request':
            return text(
                'maintainerr_error_invalid_configuration',
                'Maintainerr is not configured correctly.',
            );
        case 'blocked_target':
            return text(
                'maintainerr_error_blocked_target',
                'Canopy blocked the configured Maintainerr destination.',
            );
        case 'response_too_large':
            return text(
                'maintainerr_error_response_too_large',
                'A Maintainerr response exceeded Canopy’s safe size limit.',
            );
        case 'too_large':
            return text(
                'maintainerr_error_too_large',
                'Maintainerr returned too many records for Canopy to display safely.',
            );
        case 'malformed_body':
        case 'malformed_response':
            return text(
                'maintainerr_error_malformed_body',
                'Maintainerr returned data in an unexpected format.',
            );
        case 'configuration_changed':
            return text(
                'maintainerr_error_configuration_changed',
                'Maintainerr settings changed during the request. Try again.',
            );
        case 'identity_mismatch':
            return text(
                'maintainerr_identity_mismatch',
                'The configured Jellyfin server identity does not match.',
            );
        case 'wrong_service':
            return text(
                'maintainerr_error_wrong_service',
                'The configured destination is not Maintainerr 3.18.',
            );
        case 'not_ready':
            return text(
                'maintainerr_error_not_ready',
                'Maintainerr is reachable but is not ready.',
            );
        case 'throttled':
            return text(
                'maintainerr_error_throttled',
                'Refresh is temporarily limited. Try again in a moment.',
            );
        case 'upstream_error':
            return text(
                'maintainerr_error_upstream',
                'Maintainerr could not complete the read-only request.',
            );
        case 'unsupported':
            return text(
                'maintainerr_error_unsupported',
                'This operation is not supported by the connected Maintainerr version.',
            );
        case 'redirect':
            return text(
                'maintainerr_error_redirect',
                'Maintainerr redirected the request, which Canopy does not follow.',
            );
        case 'canceled':
            return text(
                'maintainerr_error_canceled',
                'The Maintainerr request was canceled.',
            );
        case 'timeout':
            return text(
                'maintainerr_error_timeout',
                'The Maintainerr request timed out.',
            );
        case 'disabled':
            return text(
                'maintainerr_error_disabled',
                'The Maintainerr integration or this feature is disabled.',
            );
        case 'unavailable':
            return text(
                'maintainerr_error_unavailable',
                'Maintainerr is temporarily unavailable.',
            );
        default:
            return fallback;
    }
}
