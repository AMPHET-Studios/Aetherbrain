#include "AetherBrainHUD.h"

#include "AetherBrainActor.h"
#include "AetherFxActor.h"
#include "AetherSpaceActor.h"
#include "AetherBrainPlayerController.h"
#include "Engine/Canvas.h"

namespace
{
	const TCHAR* KindName(EAetherKind Kind)
	{
		switch (Kind)
		{
		case EAetherKind::Sun: return TEXT("drive");
		case EAetherKind::Star: return TEXT("project");
		case EAetherKind::Planet: return TEXT("folder");
		case EAetherKind::Ghost: return TEXT("note to write");
		case EAetherKind::Picture: return TEXT("picture");
		case EAetherKind::Today: return TEXT("today");
		default: return TEXT("note");
		}
	}
}

void AAetherBrainHUD::DrawHUD()
{
	Super::DrawHUD();
	const AAetherBrainPlayerController* Pc = Cast<AAetherBrainPlayerController>(GetOwningPlayerController());
	const AAetherBrainActor* Brain = Pc ? Pc->GetBrain() : nullptr;
	if (!Canvas || !Brain)
	{
		return;
	}
	const FLinearColor Ink(0.91f, 0.93f, 1.f);
	const FLinearColor Dim(0.55f, 0.6f, 0.75f);
	const FLinearColor Gold(1.f, 0.81f, 0.42f);

	DrawText(Brain->IsLive() ? TEXT("Aether Brain - live") : TEXT("Aether Brain - not connected"), Brain->IsLive() ? Gold : Dim, 24.f, 20.f, nullptr, 1.1f);
	DrawText(Brain->GetStatus(), Dim, 24.f, 44.f);
	if (Brain->IsMaterialMissing())
	{
		DrawText(TEXT("Glow material missing: open the project in the Unreal Editor once (Python plugin on) to make it."), FLinearColor(1.f, 0.45f, 0.5f), 24.f, 64.f);
	}

	if (const AAetherSpaceActor* Space = Pc->GetSpace())
	{
		DrawText(FString::Printf(TEXT("Space: %s  (B)"), Space->GetModeName()), Dim, Canvas->ClipX - 230.f, 20.f);
		if (Space->IsSpriteMaterialMissing())
		{
			DrawText(TEXT("Sky material missing: open the project in the Unreal Editor once (Python plugin on)."), FLinearColor(1.f, 0.45f, 0.5f), 24.f, 84.f);
		}
	}

	if (const AAetherFxActor* Fx = Pc->GetFx())
	{
		const FString Line = Fx->IsOn()
			? FString::Printf(TEXT("Effects: on - %d of %d Niagara systems, %d playing  (N)"), Fx->NumReady(), AAetherFxActor::NumSystems(), Fx->NumPlaying())
			: FString(TEXT("Effects: off  (N)"));
		DrawText(Line, Dim, Canvas->ClipX - 330.f, 44.f);
		if (Fx->NumReady() < AAetherFxActor::NumSystems())
		{
			FString Missing;
			for (int32 I = 0; I < AAetherFxActor::NumSystems(); ++I)
			{
				if (!Fx->IsReady(I))
				{
					if (!Missing.IsEmpty())
					{
						Missing += TEXT(", ");
					}
					Missing += AAetherFxActor::SystemName(I);
				}
			}
			DrawText(FString::Printf(TEXT("Niagara systems missing (not played): %s - build them from docs/UNREAL-NIAGARA.md"), *Missing), FLinearColor(1.f, 0.45f, 0.5f), 24.f, 104.f);
		}
	}

	if (const FAetherNode* Node = Brain->GetNode(Pc->GetHovered()))
	{
		float X = 0.f;
		float Y = 0.f;
		Pc->GetMousePosition(X, Y);
		DrawText(FString::Printf(TEXT("%s  -  %s"), *Node->Title, KindName(Node->Kind)), Ink, X + 18.f, Y + 6.f, nullptr, 1.05f);
	}
	if (const FAetherNode* Node = Brain->GetNode(Brain->GetSelected()))
	{
		DrawText(FString::Printf(TEXT("Selected: %s (%s)  -  Enter opens it in Aether Brain  -  F flies to it"), *Node->Title, KindName(Node->Kind)), Ink, 24.f, Canvas->ClipY - 64.f);
	}
	DrawText(
		FString::Printf(TEXT("Right mouse: look  -  WASD: fly  -  Q / E: down / up  -  Shift: faster  -  wheel: speed (%.0f m/s)  -  click: select  -  double-click: open  -  H: everything  -  Tab: next star  -  B: space  -  N: effects"), Pc->GetSpeed() / 100.f),
		Dim, 24.f, Canvas->ClipY - 40.f);
}
