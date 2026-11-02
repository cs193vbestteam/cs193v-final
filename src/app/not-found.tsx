import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md card text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">That plan or page doesn't exist. Check the invite link?</p>
      <Link href="/" className="btn mt-4">Go home</Link>
    </div>
  );
}
