/**
 * WhatsApp click-to-chat links (https://wa.me/<number>?text=<message>).
 *
 * Nothing is sent by the server: the administrator taps the link, WhatsApp
 * opens with the recipient and a prefilled message, and the administrator
 * presses Send manually. No WhatsApp Business API or paid service is involved.
 *
 * The number in a wa.me URL must be international format with digits only:
 * no "+", spaces, hyphens or brackets, and no leading zeros.
 */
const toWhatsAppDigits = (e164) => {
  const digits = String(e164 || '').replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
};

const buildWhatsAppUrl = (phone, message) => {
  const digits = toWhatsAppDigits(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
};

const formatValidity = (hours) => (hours === 1 ? '1 hour' : `${hours} hours`);

const doctorInvitationMessage = (code, expiresInHours) =>
  `Hello! You have been invited to register as a doctor in the Leukemia Detection System.\n\n` +
  `Your doctor registration invitation code is: ${code}\n\n` +
  `This code expires in ${formatValidity(expiresInHours)} and can only be used once. ` +
  `Please register using the email address associated with this invitation.\n\n` +
  `Your professional credentials will be reviewed by the administrator before doctor access is approved.`;

const passwordResetMessage = (code, expiresInHours) =>
  `Hello! An administrator generated a password reset code for your Leukemia Detection System doctor account.\n\n` +
  `Your password reset code is: ${code}\n\n` +
  `This code expires in ${formatValidity(expiresInHours)} and can only be used once. ` +
  `If you did not ask for a password reset, please ignore this message and tell the administrator.`;

module.exports = {
  toWhatsAppDigits,
  buildWhatsAppUrl,
  doctorInvitationMessage,
  passwordResetMessage,
};
