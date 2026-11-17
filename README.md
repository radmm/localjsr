# H2S Badge Reader
[![Repo Audited - Grade: F](https://repo-auditor.dev/badge/audit-mwauozo5-leuv.svg)](https://repo-auditor.dev/r/audit-mwauozo5-leuv)
## Color-reading pipeline

- Camera captures use the on-screen badge guide as a source-pixel crop. Uploaded photos require a user-drawn crop before analysis.
- `ROI_LAYOUT` in `app.js` is the versioned badge-relative source for the strip, six reference swatches, and sealed reference ROI. Each rectangle is inset by 25% on every side before sampling.
- ROI colors are per-channel pixel medians. Camera captures keep three frames, reject the most-distant frame per ROI, then take the median of the remaining two.
- Captures are refused for non-uniform patches (initial max channel standard deviation `24`), clipping above `2%`, Laplacian variance below `20`, strip/background similarity below `10 RGB`, or the existing reference-fit residual above `32 RGB RMS`.
- Those gate thresholds are initial engineering values and have not been tuned against field captures. The ROI positions carry forward the app's assumed badge layout and also need confirmation against printed badges.
- Successful `v1.6` records store ROI medians, ROI layout version, and a small cropped badge thumbnail. Older records retain their original version and are marked as legacy; they are never rewritten.
- Run the synthetic regression and gate tests with `node tests.js`.

All capture, correction, gating, and record storage run locally without a network dependency.




#include <stdio.h>

int main()
{
    int m,n,i,j,al[10][10],max[10][10];
    int av[10],need[10][10],finish[10]={0};
    int safe[10],count=0,found;

    printf("Enter no of processes: ");
    scanf("%d",&m);

    printf("Enter no of resources: ");
    scanf("%d",&n);

    // Allocation matrix
    for(i=0;i<m;i++)
        for(j=0;j<n;j++)
        {
            printf("Enter al[%d][%d]: ",i,j);
            scanf("%d",&al[i][j]);
        }

    // Maximum matrix
    for(i=0;i<m;i++)
        for(j=0;j<n;j++)
        {
            printf("Enter max[%d][%d]: ",i,j);
            scanf("%d",&max[i][j]);
        }

    // Available resources
    for(j=0;j<n;j++)
    {
        printf("Available resource av[%d]: ",j);
        scanf("%d",&av[j]);
    }

    // Calculate need matrix
    for(i=0;i<m;i++)
        for(j=0;j<n;j++)
            need[i][j]=max[i][j]-al[i][j];

    // Banker's Algorithm
    while(count<m)
    {
        found=0;

        for(i=0;i<m;i++)
        {
            if(finish[i]==0)
            {
                for(j=0;j<n;j++)
                    if(need[i][j]>av[j])
                        break;

                if(j==n)
                {
                    for(j=0;j<n;j++)
                        av[j]+=al[i][j];

                    safe[count++]=i;
                    finish[i]=1;
                    found=1;
                }
            }
        }

        if(found==0)
            break;
    }

    // Display result
    if(count==m)
    {
        printf("\nSystem is in Safe State");
        printf("\nSafe Sequence: ");

        for(i=0;i<m;i++)
            printf("P%d ",safe[i]);
    }
    else
        printf("\nSystem is in Unsafe State");

    return 0;
}

