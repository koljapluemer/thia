import { useArea } from './router';
import { Review } from './review/Review';
import { Runs } from './runs/Runs';
import { Workshop } from './workshop/Workshop';

/**
 * The make app: each area is a path. In the workshop, each draft is its own store, synced with the server
 * (web/server); what it makes is published to a class, or offered for the public site (web/site) and reviewed in
 * /review. Using views is the site's (the use app), on the same origin when deployed.
 */
export function App() {
  const area = useArea();
  return (
    <>
      {area === '/workshop' && <Workshop />}
      {area === '/review' && <Review />}
      {area === '/runs' && <Runs />}
    </>
  );
}
