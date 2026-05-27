/**
 * @file data/default-user/extensions/canonize/modal/plugin-setup-modal.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Injects and drives the CNZ plugin setup consent modal. Presents a one-time
 * dialog asking the user to allow the deployed plugin directory to be replaced
 * with a symlink to the extension's plugin/ subdirectory.
 *
 * @api-declaration
 * injectSetupModal()
 * showSymlinkConsentModal({ onConfirm, onDismiss })
 * showPermissionDeniedModal({ isDocker })
 *
 * @contract
 *   assertions:
 *     purity:          mutates (DOM)
 *     state_ownership: [none]
 *     external_io:     [DOM, jQuery]
 */

export function injectSetupModal() {
    if ($('#cnz-setup-overlay').length) return;
    $('body').append(`
<div id="cnz-setup-overlay" class="cnz-overlay cnz-hidden">
  <div id="cnz-setup-modal" class="cnz-modal cnz-li-modal" role="dialog" aria-modal="true">
    <div class="cnz-section-header">
      <h3 class="cnz-title">CNZ Plugin Setup</h3>
      <button id="cnz-setup-close" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Later</button>
    </div>
    <div class="cnz-li-body">
      <p>The CNZ plugin folder is a manual copy. CNZ can replace it with a symlink so the plugin stays in sync with the extension automatically.</p>
      <ul style="margin: 0.5em 0 0 1.2em; padding: 0; line-height: 1.7">
        <li>Your existing <code>node_modules</code> will be moved to the extension directory.</li>
        <li>Changes take effect after the next ST restart.</li>
      </ul>
    </div>
    <div class="cnz-orphan-footer">
      <button id="cnz-setup-confirm" class="cnz-btn cnz-btn-primary">Create Symlink</button>
    </div>
  </div>
</div>`);

    $('#cnz-setup-modal').on('mousedown click', e => e.stopPropagation());
}

const _DOCKER_INSTRUCTIONS = `\
From the directory containing your <code>docker-compose.yaml</code>, run:
<pre>rm -rf st-plugins/cnz
ln -s ../st-extensions/SillyTavern-Canonize/plugin st-plugins/cnz</pre>
Then restart the container.`;

const _BARE_INSTRUCTIONS = `\
From your SillyTavern root directory, run:
<pre>rm -rf plugins/cnz
ln -s public/scripts/extensions/third-party/SillyTavern-Canonize/plugin plugins/cnz</pre>
Then restart SillyTavern.`;

function _close() {
    $('#cnz-setup-overlay').addClass('cnz-hidden');
}

export function showPermissionDeniedModal({ isDocker } = {}) {
    $('#cnz-setup-modal .cnz-li-body').html(
        '<p>CNZ cannot create the symlink automatically — the <code>plugins/</code> directory ' +
        'is not writable by the ST process. You can create it manually:</p>' +
        (isDocker ? _DOCKER_INSTRUCTIONS : _BARE_INSTRUCTIONS),
    );
    $('#cnz-setup-confirm').hide();
    $('#cnz-setup-close').off('click.setup').on('click.setup', _close).text('Got it');
    $('#cnz-setup-overlay').off('click.setup').on('click.setup', _close);
    $('#cnz-setup-overlay').removeClass('cnz-hidden');
}

export function showSymlinkConsentModal({ onConfirm, onDismiss } = {}) {
    $('#cnz-setup-modal .cnz-li-body').html(
        '<p>The CNZ plugin folder is a manual copy. CNZ can replace it with a symlink so the plugin stays in sync with the extension automatically.</p>' +
        '<ul style="margin: 0.5em 0 0 1.2em; padding: 0; line-height: 1.7">' +
        '<li>Your existing <code>node_modules</code> will be moved to the extension directory.</li>' +
        '<li>Changes take effect after the next ST restart.</li>' +
        '</ul>',
    );
    $('#cnz-setup-confirm').show().prop('disabled', false).text('Create Symlink');
    $('#cnz-setup-close').text('Later');

    $('#cnz-setup-close')
        .off('click.setup')
        .on('click.setup', () => { _close(); onDismiss?.(); });

    $('#cnz-setup-overlay')
        .off('click.setup')
        .on('click.setup', () => { _close(); onDismiss?.(); });

    $('#cnz-setup-confirm')
        .off('click.setup')
        .prop('disabled', false)
        .text('Create Symlink')
        .on('click.setup', async function () {
            $(this).prop('disabled', true).text('Working...');
            try {
                await onConfirm?.();
                _close();
            } catch (err) {
                $(this).prop('disabled', false).text('Create Symlink');
                toastr.error(`CNZ: symlink creation failed — ${err.message}`);
            }
        });

    $('#cnz-setup-overlay').removeClass('cnz-hidden');
}
