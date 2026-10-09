#include "AetherScene.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformMisc.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	/** "AEP1" read as a little-endian uint32. */
	constexpr uint32 PositionsMagic = 0x31504541;
	constexpr int32 PositionsHeader = 16;
	/**
	 * What a scene may hold. The desktop app sends far less (it cuts a big brain to a budget well under these); they are a backstop, so
	 * a scene that is not that app's, or from a build without the cut, is refused and not drawn into a stall.
	 */
	constexpr int32 MaxNodes = 50000;
	constexpr int32 MaxEdgeNumbers = 100000;

	EAetherKind KindOf(const FString& Kind)
	{
		if (Kind == TEXT("sun")) return EAetherKind::Sun;
		if (Kind == TEXT("star")) return EAetherKind::Star;
		if (Kind == TEXT("planet")) return EAetherKind::Planet;
		if (Kind == TEXT("ghost")) return EAetherKind::Ghost;
		if (Kind == TEXT("picture")) return EAetherKind::Picture;
		if (Kind == TEXT("today")) return EAetherKind::Today;
		return EAetherKind::Moon;
	}

	uint32 ReadU32(const TArray<uint8>& Bytes, int32 Offset)
	{
		uint32 V = 0;
		FMemory::Memcpy(&V, Bytes.GetData() + Offset, sizeof(uint32));
		return V;
	}
}

bool AetherScene::ParseGraph(const FString& Json, FAetherGraph& Out, bool* bOutTooBig)
{
	if (bOutTooBig)
	{
		*bOutTooBig = false;
	}
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Json);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	double Version = 0;
	const TArray<TSharedPtr<FJsonValue>>* Nodes = nullptr;
	const TArray<TSharedPtr<FJsonValue>>* Edges = nullptr;
	if (!Root->TryGetNumberField(TEXT("version"), Version) || !Root->TryGetArrayField(TEXT("nodes"), Nodes) || !Root->TryGetArrayField(TEXT("edges"), Edges))
	{
		return false;
	}
	if (!Nodes || !Edges || Edges->Num() % 2 != 0)
	{
		return false;
	}
	if (Nodes->Num() > MaxNodes)
	{
		if (bOutTooBig)
		{
			*bOutTooBig = true;
		}
		return false;
	}

	FAetherGraph G;
	G.Version = static_cast<uint32>(Version);
	Root->TryGetStringField(TEXT("vault"), G.Vault);
	Root->TryGetStringField(TEXT("layout"), G.Layout);

	const int32 N = Nodes->Num();
	G.Nodes.Reserve(N);
	for (const TSharedPtr<FJsonValue>& Value : *Nodes)
	{
		const TSharedPtr<FJsonObject>* Obj = nullptr;
		if (!Value.IsValid() || !Value->TryGetObject(Obj) || Obj == nullptr || !Obj->IsValid())
		{
			return false;
		}
		FAetherNode Node;
		FString Kind;
		FString Color;
		double Radius = 1.0;
		double Parent = -1.0;
		if (!(*Obj)->TryGetStringField(TEXT("id"), Node.Id) || Node.Id.IsEmpty())
		{
			return false;
		}
		(*Obj)->TryGetStringField(TEXT("title"), Node.Title);
		(*Obj)->TryGetStringField(TEXT("kind"), Kind);
		(*Obj)->TryGetStringField(TEXT("color"), Color);
		(*Obj)->TryGetNumberField(TEXT("radius"), Radius);
		(*Obj)->TryGetNumberField(TEXT("parent"), Parent);
		Node.Kind = KindOf(Kind);
		// The brain's colours are sRGB hex (#rrggbb).
		Node.Color = Color.Len() == 7 ? FLinearColor::FromSRGBColor(FColor::FromHex(Color)) : FLinearColor::White;
		Node.Radius = FMath::Clamp(static_cast<float>(Radius), 0.f, 1000.f);
		const int32 P = static_cast<int32>(Parent);
		Node.Parent = P >= 0 && P < N ? P : INDEX_NONE;
		G.Nodes.Add(MoveTemp(Node));
	}

	// Links past the limit are not drawn (the first are the ones that matter); the rest of the scene is.
	const int32 EdgeNumbers = FMath::Min(Edges->Num(), MaxEdgeNumbers);
	G.Edges.Reserve(EdgeNumbers);
	for (int32 K = 0; K < EdgeNumbers; ++K)
	{
		const TSharedPtr<FJsonValue>& Value = (*Edges)[K];
		double X = -1.0;
		if (!Value.IsValid() || !Value->TryGetNumber(X))
		{
			return false;
		}
		const int32 I = static_cast<int32>(X);
		if (I < 0 || I >= N)
		{
			return false;
		}
		G.Edges.Add(I);
	}

	double Selected = -1.0;
	Root->TryGetNumberField(TEXT("selected"), Selected);
	const int32 S = static_cast<int32>(Selected);
	G.Selected = S >= 0 && S < N ? S : INDEX_NONE;

	// Present when what is here is a part of a bigger brain.
	const TSharedPtr<FJsonObject>* Limits = nullptr;
	if (Root->TryGetObjectField(TEXT("limits"), Limits) && Limits != nullptr && Limits->IsValid())
	{
		double OfNodes = 0.0;
		double OfLinks = 0.0;
		(*Limits)->TryGetNumberField(TEXT("ofNodes"), OfNodes);
		(*Limits)->TryGetNumberField(TEXT("ofLinks"), OfLinks);
		G.TotalNodes = static_cast<int32>(FMath::Clamp(OfNodes, 0.0, 2000000000.0));
		G.TotalLinks = static_cast<int32>(FMath::Clamp(OfLinks, 0.0, 2000000000.0));
	}

	Out = MoveTemp(G);
	return true;
}

bool AetherScene::ParsePositions(const TArray<uint8>& Bytes, FAetherPositions& Out)
{
	if (Bytes.Num() < PositionsHeader || ReadU32(Bytes, 0) != PositionsMagic)
	{
		return false;
	}
	const uint32 Version = ReadU32(Bytes, 4);
	const int64 NodeCount = ReadU32(Bytes, 8);
	const int64 RingCount = ReadU32(Bytes, 12);
	if (NodeCount > MaxNodes)
	{
		return false;
	}
	// The frame must be exactly as long as it says; of its rings only the first (the biggest systems) are kept.
	if (static_cast<int64>(Bytes.Num()) != PositionsHeader + (NodeCount * 3 + RingCount * 6) * 4)
	{
		return false;
	}
	const int64 KeptRings = FMath::Min<int64>(RingCount, MaxPositionRings);
	const int64 FloatCount = NodeCount * 3 + KeptRings * 6;

	TArray<float> F;
	F.SetNumUninitialized(static_cast<int32>(FloatCount));
	if (FloatCount > 0)
	{
		FMemory::Memcpy(F.GetData(), Bytes.GetData() + PositionsHeader, FloatCount * sizeof(float));
	}

	FAetherPositions P;
	P.Version = Version;
	P.Points.SetNumUninitialized(static_cast<int32>(NodeCount));
	for (int32 I = 0; I < NodeCount; ++I)
	{
		P.Points[I] = FVector(static_cast<double>(F[I * 3]), static_cast<double>(F[I * 3 + 1]), static_cast<double>(F[I * 3 + 2]));
	}
	const int32 Base = static_cast<int32>(NodeCount * 3);
	P.Rings.SetNum(static_cast<int32>(KeptRings));
	for (int32 K = 0; K < KeptRings; ++K)
	{
		const float* R = F.GetData() + Base + K * 6;
		FAetherRing& Ring = P.Rings[K];
		const int32 Parent = static_cast<int32>(R[0]);
		Ring.Parent = Parent >= 0 && Parent < NodeCount ? Parent : INDEX_NONE;
		Ring.Radius = R[1];
		Ring.Rotation = FQuat(static_cast<double>(R[2]), static_cast<double>(R[3]), static_cast<double>(R[4]), static_cast<double>(R[5]));
		Ring.Rotation.Normalize();
	}
	Out = MoveTemp(P);
	return true;
}

FVector AetherScene::RingPoint(const FAetherRing& R, const FVector& C, float T)
{
	// Plain quaternion math in the brain's own frame; the caller converts the result to Unreal space.
	return C + R.Rotation.RotateVector(FVector(static_cast<double>(R.Radius * FMath::Cos(T)), 0.0, static_cast<double>(R.Radius * FMath::Sin(T))));
}

TArray<FString> AetherScene::ConnectionFileCandidates()
{
	// Electron's data folder: <app data>/<app name>. The installed app is "Aether Brain"; a dev build uses the package name.
	TArray<FString> Bases;
#if PLATFORM_WINDOWS
	const FString AppData = FPlatformMisc::GetEnvironmentVariable(TEXT("APPDATA"));
	if (!AppData.IsEmpty()) Bases.Add(AppData);
#elif PLATFORM_MAC
	const FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
	if (!Home.IsEmpty()) Bases.Add(Home / TEXT("Library/Application Support"));
#else
	const FString Xdg = FPlatformMisc::GetEnvironmentVariable(TEXT("XDG_CONFIG_HOME"));
	const FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
	if (!Xdg.IsEmpty()) Bases.Add(Xdg);
	if (!Home.IsEmpty()) Bases.Add(Home / TEXT(".config"));
#endif
	TArray<FString> Out;
	for (const FString& Base : Bases)
	{
		Out.Add(Base / TEXT("Aether Brain") / TEXT("companion.json"));
		Out.Add(Base / TEXT("@aether") / TEXT("desktop") / TEXT("companion.json"));
	}
	return Out;
}

bool AetherScene::ReadConnectionFile(FAetherConnection& Out)
{
	for (const FString& File : ConnectionFileCandidates())
	{
		FString Text;
		if (!FPaths::FileExists(File) || !FFileHelper::LoadFileToString(Text, *File))
		{
			continue;
		}
		TSharedPtr<FJsonObject> Root;
		const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Text);
		if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
		{
			continue;
		}
		FAetherConnection C;
		Root->TryGetStringField(TEXT("url"), C.Url);
		Root->TryGetStringField(TEXT("token"), C.Token);
		C.Source = File;
		if (C.IsValid())
		{
			Out = C;
			return true;
		}
	}
	return false;
}

bool AetherScene::ReadCommandLine(FAetherConnection& Out)
{
	FAetherConnection C;
	FParse::Value(FCommandLine::Get(), TEXT("AetherUrl="), C.Url);
	FParse::Value(FCommandLine::Get(), TEXT("AetherToken="), C.Token);
	C.Source = TEXT("the command line");
	if (!C.IsValid())
	{
		return false;
	}
	Out = C;
	return true;
}
