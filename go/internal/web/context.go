package web

import (
	"context"
)

func setVal(ctx context.Context, k ctxKey, v any) context.Context { return context.WithValue(ctx, k, v) }

func getVal(ctx context.Context, k ctxKey) any {
	if ctx == nil {
		return nil
	}
	return ctx.Value(k)
}
