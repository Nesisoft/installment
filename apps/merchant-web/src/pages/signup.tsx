import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, apiErrorMessage } from '@installment/web-kit';
import { GHANA_REGIONS, merchantSignupCompleteSchema } from '@installment/api-types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@installment/ui';
import { ArrowLeft, Store } from 'lucide-react';
import { useShopCategories } from '../lib/merchant-api';

/**
 * Opening a shop, in three steps.
 *
 * The phone comes first and creates nothing: a code proves a person is behind
 * the application before anybody is asked to fill in a form, and an abandoned
 * attempt leaves no rows behind. The business details come last, on a ticket
 * the server minted for that proven number — so a caller cannot verify one
 * number and register another.
 *
 * What the form does not ask for is as deliberate as what it does. No
 * commission or reserve rate: those are the marketplace's terms. No shopfront
 * address: it is derived from the shop name, because it is permanent afterwards
 * and the middle of a signup form is the wrong place to choose a URL you cannot
 * change.
 */
type Step = 'phone' | 'code' | 'business';

export function SignupPage() {
  const { startMerchantSignup, verifyMerchantSignupCode, completeMerchantSignup } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [signupToken, setSignupToken] = useState('');

  const [businessName, setBusinessName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tin, setTin] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [momoNumber, setMomoNumber] = useState('');
  const [momoProvider, setMomoProvider] = useState<'' | 'mtn' | 'tgo' | 'vod'>('');
  const categories = useShopCategories();

  async function run(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(apiErrorMessage(err, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await startMerchantSignup(phone.trim());
      setStep('code');
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { signupToken: ticket } = await verifyMerchantSignupCode(phone.trim(), code.trim());
      setSignupToken(ticket);
      setStep('business');
    });
  };

  const submitBusiness = (e: FormEvent) => {
    e.preventDefault();
    const parsed = merchantSignupCompleteSchema.safeParse({
      signupToken,
      business_name: businessName.trim(),
      legal_name: legalName.trim(),
      email: email.trim(),
      password,
      ...(tin.trim() ? { tin: tin.trim() } : {}),
      ...(categorySlug ? { primary_category_slug: categorySlug } : {}),
      ...(city.trim() ? { city: city.trim() } : {}),
      ...(region ? { region } : {}),
      // Both or neither, which is what the schema refines on. A number typed
      // without a network picked is the one case worth catching here rather
      // than after a round trip.
      ...(momoNumber.trim() && momoProvider
        ? { momo_number: momoNumber.trim(), momo_provider: momoProvider }
        : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details and try again.');
      return;
    }
    // On success the session is stored, so ProtectedRoute lets them straight
    // into the portal — where everything works and nothing is public yet.
    void run(async () => {
      await completeMerchantSignup(parsed.data);
    });
  };

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Store className="size-6" />
          </span>
          <h1 className="text-xl font-semibold text-foreground">Sell on Ejua</h1>
          <p className="text-sm text-muted-foreground">
            List your stock, offer instalments, get paid.
          </p>
        </div>

        <Card>
          {step === 'phone' ? (
            <>
              <CardHeader>
                <CardTitle className="text-base">Your phone number</CardTitle>
                <CardDescription>
                  We will text you a code. Nothing is created until it is confirmed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitPhone} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      type="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="0244 123 456"
                      required
                    />
                  </div>
                  {error ? <p className="text-sm text-destructive">{error}</p> : null}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? 'Sending…' : 'Send me a code'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : null}

          {step === 'code' ? (
            <>
              <CardHeader>
                <CardTitle className="text-base">Enter the code</CardTitle>
                <CardDescription>Sent to {phone}.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitCode} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="code">Code</Label>
                    <Input
                      id="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="123456"
                      required
                    />
                  </div>
                  {error ? <p className="text-sm text-destructive">{error}</p> : null}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? 'Checking…' : 'Continue'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setStep('phone');
                    }}
                  >
                    Use a different number
                  </Button>
                </form>
              </CardContent>
            </>
          ) : null}

          {step === 'business' ? (
            <>
              <CardHeader>
                <CardTitle className="text-base">About your business</CardTitle>
                <CardDescription>
                  You can set up your shop straight away. It stays private until we have reviewed
                  it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitBusiness} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="business_name">Shop name</Label>
                    <Input
                      id="business_name"
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="Auntie Akos Kente"
                      maxLength={200}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      What buyers will see. Your shop address is made from this.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="legal_name">Registered name</Label>
                    <Input
                      id="legal_name"
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                      placeholder="Akosua Ventures Ltd"
                      maxLength={200}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@yourshop.gh"
                      required
                    />
                    <p className="text-xs text-muted-foreground">This is how you will sign in.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="category">What do you mainly sell?</Label>
                    <select
                      id="category"
                      className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                      value={categorySlug}
                      onChange={(e) => setCategorySlug(e.target.value)}
                      disabled={categories.isPending}
                    >
                      <option value="">Not sure yet</option>
                      {(categories.data ?? []).map((c) => (
                        <option key={c.slug} value={c.slug}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Where buyers browsing shops will find you. You can change it later.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="city">Town or market (optional)</Label>
                      <Input
                        id="city"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="Makola, Accra"
                        maxLength={120}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="region">Region</Label>
                      <select
                        id="region"
                        className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                      >
                        <option value="">Not sure yet</option>
                        {GHANA_REGIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="-mt-2 text-xs text-muted-foreground">
                    Shown on your shopfront, so a buyer can see whether you are nearby. You can
                    change it later.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="momo_number">MoMo number for payouts (optional)</Label>
                    <div className="flex gap-2">
                      <select
                        aria-label="Mobile money network"
                        className="h-9 w-32 shrink-0 rounded-md border border-input bg-card px-2 text-sm"
                        value={momoProvider}
                        onChange={(e) =>
                          setMomoProvider(e.target.value as '' | 'mtn' | 'tgo' | 'vod')
                        }
                      >
                        <option value="">Network</option>
                        <option value="mtn">MTN</option>
                        <option value="vod">Telecel</option>
                        <option value="tgo">AirtelTigo</option>
                      </select>
                      <Input
                        id="momo_number"
                        inputMode="tel"
                        value={momoNumber}
                        onChange={(e) => setMomoNumber(e.target.value)}
                        placeholder="024 455 1338"
                      />
                    </div>
                    {/* Said plainly, because the number has to be the owner's
                        and a merchant who learns that later has already given
                        us the wrong one. */}
                    <p className="text-xs text-muted-foreground">
                      We check the name on the wallet before saving it, so it has to be in the
                      business owner&rsquo;s name. Add it later from Payout account if you prefer.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tin">TIN (optional)</Label>
                    <Input
                      id="tin"
                      value={tin}
                      onChange={(e) => setTin(e.target.value)}
                      placeholder="C0012345678"
                      maxLength={60}
                    />
                    <p className="text-xs text-muted-foreground">
                      Speeds up review. You can add it later.
                    </p>
                  </div>
                  {error ? <p className="text-sm text-destructive">{error}</p> : null}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy ? 'Creating your shop…' : 'Create my shop'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : null}
        </Card>

        <Link
          to="/login"
          className="mt-6 flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />I already have an account
        </Link>
      </div>
    </div>
  );
}
