#include "AetherBrainHUD.h"

#include "AetherBrainActor.h"
#include "AetherFxActor.h"
#include "AetherSpaceActor.h"
#include "AetherVoyageActor.h"
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

void AAetherBrainHUD::DrawVoyage(const AAetherBrainPlayerController* Pc, const AAetherBrainActor* Brain)
{
	const AAetherVoyageActor* V = Pc->GetVoyage();
	if (!V || !Canvas)
	{
		return;
	}
	const FLinearColor Dim(0.55f, 0.6f, 0.75f);
	const FLinearColor Warn(1.f, 0.45f, 0.5f);
	const FLinearColor Ink(0.91f, 0.93f, 1.f);
	const FLinearColor Gold(1.f, 0.81f, 0.42f);
	const FLinearColor Cyan(0.45f, 0.85f, 1.f);
	const FString Status = V->GetStatus();
	if (!Status.IsEmpty())
	{
		DrawText(Status, V->IsSkyReady() ? Dim : Gold, 24.f, 124.f);
	}
	DrawText(FString::Printf(TEXT("Folder pictures: %d/%d  -  V: voyage to the selected folder"), V->NumCardsWithPictures(), V->NumCardsShown()), Dim, Canvas->ClipX - 440.f, 68.f);
	if (Pc->HasVoyageNote())
	{
		DrawText(Pc->GetVoyageNote(), Warn, Canvas->ClipX * 0.5f - 220.f, Canvas->ClipY * 0.2f, nullptr, 1.1f);
	}
	if (!V->IsVoyaging())
	{
		return;
	}
	const FAetherNode* Node = Brain->GetNode(V->GetVoyageNode());
	const float Cx = Canvas->ClipX * 0.5f;
	const FString Title = Node ? Node->Title : FString(TEXT("the folder"));
	if (V->HasArrived())
	{
		DrawText(FString::Printf(TEXT("Arrived at %s  -  Enter opens it in Aether Brain  -  V or Esc leaves"), *Title), Gold, Cx - 280.f, 90.f, nullptr, 1.2f);
	}
	else
	{
		DrawText(FString::Printf(TEXT("Voyage to %s  -  %.0f m to go"), *Title, V->GetDistanceToGoMeters()), Ink, Cx - 170.f, 90.f, nullptr, 1.2f);
	}
	// Progress and the ship's shield and hull.
	const float BarW = 360.f;
	const float BarX = Cx - BarW * 0.5f;
	DrawRect(FLinearColor(0.1f, 0.12f, 0.2f, 0.8f), BarX, 120.f, BarW, 6.f);
	DrawRect(Gold, BarX, 120.f, BarW * FMath::Clamp(V->GetProgress(), 0.f, 1.f), 6.f);
	DrawRect(FLinearColor(0.1f, 0.12f, 0.2f, 0.8f), BarX, 134.f, BarW * 0.5f - 4.f, 6.f);
	DrawRect(Cyan, BarX, 134.f, (BarW * 0.5f - 4.f) * FMath::Clamp(V->GetShieldFraction(), 0.f, 1.f), 6.f);
	DrawRect(FLinearColor(0.1f, 0.12f, 0.2f, 0.8f), BarX + BarW * 0.5f + 4.f, 134.f, BarW * 0.5f - 4.f, 6.f);
	DrawRect(Warn, BarX + BarW * 0.5f + 4.f, 134.f, (BarW * 0.5f - 4.f) * FMath::Clamp(V->GetHullFraction(), 0.f, 1.f), 6.f);
	DrawText(FString::Printf(TEXT("shield %.0f%%   hull %.0f%%   rocks broken %d   score %d   speed %.0f%%"), V->GetShieldFraction() * 100.f, V->GetHullFraction() * 100.f, V->GetRocksBroken(), V->GetScore(), Pc->GetThrottle() * 100.f), Dim, Cx - 190.f, 146.f);
	DrawText(TEXT("A / D / Q / E steer  -  W / S speed  -  hold left mouse or Space: fire where the cursor points"), Dim, 24.f, Canvas->ClipY - 64.f);

	// The crosshair where the guns point, and a bracket on the rock the sights are on.
	FVector Aim;
	if (V->GetAimPoint(Aim))
	{
		const FVector P = Project(Aim);
		if (P.Z > 0.f)
		{
			DrawLine(P.X - 14.f, P.Y, P.X - 5.f, P.Y, Cyan, 2.f);
			DrawLine(P.X + 5.f, P.Y, P.X + 14.f, P.Y, Cyan, 2.f);
			DrawLine(P.X, P.Y - 14.f, P.X, P.Y - 5.f, Cyan, 2.f);
			DrawLine(P.X, P.Y + 5.f, P.X, P.Y + 14.f, Cyan, 2.f);
		}
	}
	FVector Rock;
	float RadiusCm = 0.f;
	if (V->GetTargetRock(Rock, RadiusCm))
	{
		const FVector P = Project(Rock);
		const FVector Edge = Project(Rock + FVector(0.0, 0.0, static_cast<double>(RadiusCm)));
		if (P.Z > 0.f && Edge.Z > 0.f)
		{
			const float R = FMath::Clamp(FMath::Abs(Edge.Y - P.Y) * 1.15f + 8.f, 14.f, 260.f);
			const float L = R * 0.35f;
			for (const float Sx : {-1.f, 1.f})
			{
				for (const float Sy : {-1.f, 1.f})
				{
					DrawLine(P.X + Sx * R, P.Y + Sy * R, P.X + Sx * (R - L), P.Y + Sy * R, Gold, 2.f);
					DrawLine(P.X + Sx * R, P.Y + Sy * R, P.X + Sx * R, P.Y + Sy * (R - L), Gold, 2.f);
				}
			}
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
			? FString::Printf(TEXT("Effects: on - %d/%d systems, %d playing  (N)"), Fx->NumReady(), AAetherFxActor::NumSystems(), Fx->NumPlaying())
			: FString(TEXT("Effects: off  (N)"));
		DrawText(Line, Dim, Canvas->ClipX - 340.f, 44.f);
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

	DrawVoyage(Pc, Brain);

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
		FString::Printf(TEXT("Right mouse: look  -  WASD: fly  -  Q / E: down / up  -  Shift: faster  -  wheel: speed (%.0f m/s)  -  click: select  -  double-click: open  -  H: everything  -  Tab: next star  -  B: space  -  N: effects  -  V: voyage"), Pc->GetSpeed() / 100.f),
		Dim, 24.f, Canvas->ClipY - 40.f);
}
