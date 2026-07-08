import { Card } from "@/components/ui";

export function Info({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg">
      <Card className="p-8 text-center">
        <h1 className="text-xl font-extrabold">{title}</h1>
        <p className="mt-2 text-sm text-sub">{body}</p>
      </Card>
    </div>
  );
}
