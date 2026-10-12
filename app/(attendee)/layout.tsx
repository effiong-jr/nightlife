// Attendee pages stay plain web: never prompt club-goers to install the app
// (that's for staff). Inline so it's listening before anything else loads.
const SUPPRESS_INSTALL_PROMPT = `addEventListener("beforeinstallprompt",function(e){e.preventDefault()})`;

export default function AttendeeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: SUPPRESS_INSTALL_PROMPT }} />
      {children}
    </>
  );
}
