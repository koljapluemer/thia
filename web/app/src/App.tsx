import { Notes } from './notes/Notes';
import { HomeProvider } from './home';
import { Landing } from './Landing';
import { useArea } from './router';
import { Review } from './review/Review';
import { Workshop } from './workshop/Workshop';

/**
 * The one app: each area is a path, and `/` shows where to go. Notes are the home store (opened once, kept open). In
 * the workshop, each draft is its own store, synced with the server (web/server); what it makes is published to a
 * class, or offered for the public site (web/site) and reviewed in /review.
 */
export function App() {
  const area = useArea();
  return (
    <HomeProvider>
      {area === '/' && <Landing />}
      {area === '/notes' && <Notes />}
      {area === '/workshop' && <Workshop />}
      {area === '/review' && <Review />}
    </HomeProvider>
  );
}
